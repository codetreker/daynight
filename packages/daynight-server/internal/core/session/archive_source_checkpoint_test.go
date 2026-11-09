package session

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type sourceCheckpointDAO struct {
	*imageRuleDAO
	hashes map[string][]byte
	fail   bool
}

func (d *sourceCheckpointDAO) key(h store.SessionSourceHash) string {
	return h.SessionID + "/" + h.SourceEpoch + "/" + h.Kind + "/" + h.Identity
}
func (d *sourceCheckpointDAO) SessionSourceHash(_ context.Context, h store.SessionSourceHash) ([]byte, error) {
	digest, ok := d.hashes[d.key(h)]
	if !ok {
		return nil, model.ErrNotFound
	}
	return append([]byte(nil), digest...), nil
}
func (d *sourceCheckpointDAO) SaveSessionSourceHash(_ context.Context, h store.SessionSourceHash) error {
	if d.fail {
		return errors.New("hash commit outcome unknown")
	}
	if prior, ok := d.hashes[d.key(h)]; ok && !bytes.Equal(prior, h.Digest) {
		return conflict()
	}
	d.hashes[d.key(h)] = append([]byte(nil), h.Digest...)
	return nil
}
func stoppedCheckpointFixture(t *testing.T) (imageRuleFixture, *sourceCheckpointDAO, sp.ArchiveSourceTailRequest) {
	t.Helper()
	f := newImageRuleFixture(t, []byte("image"))
	epoch := uuid.NewString()
	f.r.SourceEpoch = &epoch
	f.r.Snapshot.Lifecycle = "archived"
	f.r.Snapshot.Activity = "stopped"
	f.r.Snapshot.Identity.ControllerID, f.r.Snapshot.Identity.ControllerInstanceID = uuid.NewString(), uuid.NewString()
	f.r.Live = nil
	media, length, digest := "image/png", "10485760", imageBytesHash([]byte("image"))
	width, height, frames := 2, 3, 1
	resource := sp.Resource{Revision: "1", ResourceID: uuid.NewString(), Status: "available", Name: "original.png", MediaType: &media, ByteLength: &length, SHA256: &digest, Width: &width, Height: &height, FrameCount: &frames}
	state := sp.State{NativeSessionID: f.r.Snapshot.Identity.NativeSessionID, InitialInputState: "not_required", Activity: "working", Synchronized: true}
	in := sp.ArchiveSourceTailRequest{Fence: f.r.Snapshot.Fence, ControllerID: f.r.Snapshot.Identity.ControllerID, ControllerInstanceID: f.r.Snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "resource", Payload: encode(resource)}, {SourceSeq: "2", Kind: "state", Payload: encode(state)}}}
	d := &sourceCheckpointDAO{imageRuleDAO: f.d, hashes: map[string][]byte{}}
	return f, d, in
}
func TestStoppedSourceCheckpointPersistsOriginalTailWithoutReactivation(t *testing.T) {
	f, d, in := stoppedCheckpointFixture(t)
	before := encode(f.r.Snapshot)
	out, e := f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, f.r, in)
	if e != nil || out.LastAckedSourceSeq != "2" || len(d.hashes) != 3 {
		t.Fatal("tail not acknowledged", out, e)
	}
	if !bytes.Equal(before, encode(f.r.Snapshot)) || f.r.Live != nil {
		t.Fatal("source tail reactivated or changed the Session")
	}
	// A new execution draft can retry after the original response was lost.
	recovered := *f.r
	recovered.Live = nil
	if out, e = f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, &recovered, in); e != nil || out.LastAckedSourceSeq != "2" || len(d.hashes) != 3 {
		t.Fatal("durable original batch retry", out, e)
	}
	changed := in
	changed.Events = append([]sp.SourceEvent(nil), in.Events...)
	changed.Events[1].Payload = bytes.Replace(in.Events[1].Payload, []byte(`"working"`), []byte(`"idle"`), 1)
	if _, e = f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, &recovered, changed); e == nil {
		t.Fatal("same batch accepted changed content")
	}
	changed.BatchID = uuid.NewString()
	if _, e = f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, &recovered, changed); e == nil {
		t.Fatal("fresh batch bypassed original event hash")
	}
}
func TestStoppedSourceCheckpointRejectsMissingTailAndChangedScope(t *testing.T) {
	for _, kind := range []string{"epoch", "fence", "controller", "instance", "gap", "missing-prefix", "noncontiguous", "native", "hash-write"} {
		t.Run(kind, func(t *testing.T) {
			f, d, in := stoppedCheckpointFixture(t)
			switch kind {
			case "epoch":
				in.SourceEpoch = uuid.NewString()
			case "fence":
				in.Fence.ExecutionGeneration = "2"
			case "controller":
				in.ControllerID = uuid.NewString()
			case "instance":
				in.ControllerInstanceID = uuid.NewString()
			case "gap":
				in.Events[0] = sp.SourceEvent{SourceSeq: "1", Kind: "gap", Payload: []byte(`{"reason":"source_floor"}`)}
			case "missing-prefix":
				in.Events = in.Events[1:]
			case "noncontiguous":
				in.Events[1].SourceSeq = "3"
			case "native":
				in.Events[1].Payload = bytes.Replace(in.Events[1].Payload, []byte(`"native"`), []byte(`"other"`), 1)
			case "hash-write":
				d.fail = true
			}
			before := encode(f.r.Snapshot)
			if _, e := f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, f.r, in); e == nil {
				t.Fatal("unproven tail acknowledged")
			}
			if f.r.SourceSeq != 0 || !bytes.Equal(before, encode(f.r.Snapshot)) {
				t.Fatal("failed tail changed public identity or checkpoint")
			}
		})
	}
}
func TestImageSourceEventsNegotiateTenMiBAndPersistHashes(t *testing.T) {
	f, d, in := stoppedCheckpointFixture(t)
	f.r.Live = newLive(f.r.Snapshot)
	message := sp.ControllerMessage{ControllerFence: f.r.Snapshot.ControllerFence, SourceEpoch: in.SourceEpoch, BatchID: in.BatchID, Events: in.Events[:1]}
	if _, e := f.s.events(t.Context(), &operationTx{dao: d}, f.r, message); e != nil {
		t.Fatal("revision2 10MiB descriptor refused", e)
	}
	if len(d.hashes) != 2 {
		t.Fatal("online events did not persist original hashes")
	}
	f.r.Live = newLive(f.r.Snapshot)
	if _, e := f.s.events(t.Context(), &operationTx{dao: d}, f.r, message); e != nil {
		t.Fatal("online retry after live cache loss", e)
	}
	old, _, oldIn := stoppedCheckpointFixture(t)
	old.r.Snapshot.ContentRevision = 0
	old.r.Live = newLive(old.r.Snapshot)
	message.SourceEpoch, message.BatchID, message.Events = oldIn.SourceEpoch, oldIn.BatchID, oldIn.Events[:1]
	if _, e := old.s.events(t.Context(), &operationTx{dao: old.d}, old.r, message); e == nil {
		t.Fatal("legacy profile silently raised resource limit")
	}
}

func TestStoppedSourceCheckpointAdoptsOnlyOriginalNativeIdentity(t *testing.T) {
	for _, known := range []bool{false, true} {
		t.Run(map[bool]string{false: "unacknowledged native", true: "acknowledged native"}[known], func(t *testing.T) {
			f, d, in := stoppedCheckpointFixture(t)
			native := "native-created-after-last-ack"
			f.r.Snapshot.Identity.NativeSessionID = nil
			if known {
				f.r.Snapshot.Identity.NativeSessionID = &native
			}
			f.r.OperationSeq = 9
			f.r.Snapshot.InitialInputState = "unknown"
			before := f.r.Snapshot
			initial := sp.State{InitialInputState: "not_submitted", Activity: "initializing"}
			final := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Activity: "working", Synchronized: true}
			in.Events = []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(initial)}, {SourceSeq: "2", Kind: "state", Payload: encode(final)}}
			for attempt := range 2 {
				out, e := f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, f.r, in)
				if e != nil || out.LastAckedSourceSeq != "2" || !sameNative(f.r.Snapshot.Identity.NativeSessionID, &native) {
					t.Fatal("original nil-to-native tail or lost-response retry refused", attempt, out, e)
				}
			}
			before.Identity.NativeSessionID = &native
			if !bytes.Equal(encode(before), encode(f.r.Snapshot)) || f.r.OperationSeq != 9 || f.r.Live != nil {
				t.Fatal("tail changed stopped state or resolved an unknown operation")
			}
			foreign := "another-native"
			final.NativeSessionID = &foreign
			in.BatchID, in.Events = uuid.NewString(), []sp.SourceEvent{{SourceSeq: "3", Kind: "state", Payload: encode(final)}}
			if _, e := f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: d}, f.r, in); e == nil || f.r.SourceSeq != 2 || !sameNative(f.r.Snapshot.Identity.NativeSessionID, &native) {
				t.Fatal("tail replaced the original native identity", e)
			}
		})
	}
}
