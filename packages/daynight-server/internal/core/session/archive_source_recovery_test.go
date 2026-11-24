package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func recoveryFixture(t *testing.T) (imageRuleFixture, *sourceCheckpointDAO, sp.ArchiveSourceRecoveryRequest) {
	f, d, tail := stoppedCheckpointFixture(t)
	return f, d, sp.ArchiveSourceRecoveryRequest{Fence: tail.Fence, ControllerID: tail.ControllerID, ControllerInstanceID: tail.ControllerInstanceID, SourceEpoch: tail.SourceEpoch, OldBatchID: tail.BatchID, RecoveryID: uuid.NewString(), Cutoff: "4", Events: tail.Events}
}
func TestSourceRecoveryPersistsReceiptAndLimitsAcknowledgement(t *testing.T) {
	f, d, in := recoveryFixture(t)
	tx := &operationTx{dao: d}
	// The first event was already acknowledged, while the second was lost.
	hash := sha256.Sum256(encode(in.Events[0]))
	d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "event", Identity: "1"})] = hash[:]
	f.r.SourceSeq = 1
	receipt, err := f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in)
	if err != nil || receipt.VerifiedThrough != "2" || receipt.CurrentThrough != "2" {
		t.Fatalf("recovery: %#v %v", receipt, err)
	}
	// A replay can observe later progress but cannot claim to have checked it.
	f.r.SourceSeq = 4
	receipt, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in)
	if err != nil || receipt.VerifiedThrough != "2" || receipt.CurrentThrough != "4" {
		t.Fatalf("replay: %#v %v", receipt, err)
	}
	f.r.SourceSeq = 5
	if _, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in); err == nil {
		t.Fatal("replay passed cutoff")
	}
	f.r.SourceSeq = 2
	changed := in
	changed.OldBatchID = uuid.NewString()
	if _, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, changed); err == nil {
		t.Fatal("recovery ID accepted different pending batch")
	}
}
func TestSourceRecoveryRejectsOldBatchOrUnverifiableEvents(t *testing.T) {
	for _, scenario := range []string{"old batch", "missing hash", "different hash", "gap", "event above cutoff", "wrong epoch"} {
		t.Run(scenario, func(t *testing.T) {
			f, d, in := recoveryFixture(t)
			switch scenario {
			case "old batch":
				d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "batch", Identity: in.OldBatchID})] = bytes.Repeat([]byte{1}, 32)
			case "missing hash":
				f.r.SourceSeq = 1
			case "different hash":
				f.r.SourceSeq = 1
				d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "event", Identity: "1"})] = bytes.Repeat([]byte{2}, 32)
			case "gap":
				in.Events = in.Events[1:]
			case "event above cutoff":
				in.Cutoff = "1"
			case "wrong epoch":
				in.SourceEpoch = uuid.NewString()
			}
			if _, err := f.s.applyStoppedSourceRecovery(t.Context(), &operationTx{dao: d}, f.r, in); err == nil {
				t.Fatal("unsafe recovery succeeded")
			}
			if len(d.recoveries) != 0 {
				t.Fatal("refusal persisted recovery")
			}
		})
	}
}

type sourceOnlyRecoveryDAO struct {
	*imageRuleDAO
	hashes *sourceCheckpointDAO
}

func (d *sourceOnlyRecoveryDAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	return d.hashes.SessionSourceHash(ctx, h)
}
func (d *sourceOnlyRecoveryDAO) PruneSessionSourceHashes(ctx context.Context, s, e string, n int64) error {
	return d.hashes.PruneSessionSourceHashes(ctx, s, e, n)
}
func (d *sourceOnlyRecoveryDAO) SessionSourceHashCount(ctx context.Context, s string) (int, error) {
	return d.hashes.SessionSourceHashCount(ctx, s)
}
func (d *sourceOnlyRecoveryDAO) SaveSessionSourceHash(ctx context.Context, h store.SessionSourceHash) error {
	return d.hashes.SaveSessionSourceHash(ctx, h)
}

type failingSourceRecoveryDAO struct {
	*sourceCheckpointDAO
	point string
	cause error
}

func (d *failingSourceRecoveryDAO) SessionSourceRecoveryCount(ctx context.Context, s string) (int, error) {
	if d.point == "count" {
		return 0, d.cause
	}
	if d.point == "capacity" {
		return 4096, nil
	}
	return d.sourceCheckpointDAO.SessionSourceRecoveryCount(ctx, s)
}
func (d *failingSourceRecoveryDAO) SessionSourceRecovery(ctx context.Context, s, id string) (store.SessionSourceRecovery, error) {
	if d.point == "read recovery" {
		return store.SessionSourceRecovery{}, d.cause
	}
	return d.sourceCheckpointDAO.SessionSourceRecovery(ctx, s, id)
}
func (d *failingSourceRecoveryDAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	if d.point == "read old batch" && h.Kind == "batch" {
		return nil, d.cause
	}
	return d.sourceCheckpointDAO.SessionSourceHash(ctx, h)
}
func (d *failingSourceRecoveryDAO) SaveSessionSourceRecovery(ctx context.Context, h store.SessionSourceRecovery) error {
	if d.point == "save recovery" {
		return d.cause
	}
	return d.sourceCheckpointDAO.SaveSessionSourceRecovery(ctx, h)
}
func TestSourceRecoveryPropagatesStorageFailuresAndCapacity(t *testing.T) {
	for _, point := range []string{"count", "read recovery", "read old batch", "save recovery", "capacity"} {
		t.Run(point, func(t *testing.T) {
			f, base, in := recoveryFixture(t)
			cause := errors.New("durable source storage failed")
			d := &failingSourceRecoveryDAO{sourceCheckpointDAO: base, point: point, cause: cause}
			_, err := f.s.applyStoppedSourceRecovery(t.Context(), &operationTx{dao: d}, f.r, in)
			if point == "capacity" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "quota_exceeded" {
					t.Fatal(err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("storage cause lost", err)
			}
			if len(base.recoveries) != 0 {
				t.Fatal("failed recovery was recorded")
			}
		})
	}
}
func TestSourceRecoveryRequiresBoundedEventsAndStorageCapabilities(t *testing.T) {
	for _, scenario := range []string{"empty", "too many", "source unsupported", "recovery unsupported"} {
		t.Run(scenario, func(t *testing.T) {
			f, d, in := recoveryFixture(t)
			var dao store.SessionDAO = d
			switch scenario {
			case "empty":
				in.Events = nil
			case "too many":
				in.Events = make([]sp.SourceEvent, sp.MaxBatchEvents+1)
			case "source unsupported":
				dao = f.d
			case "recovery unsupported":
				dao = &sourceOnlyRecoveryDAO{imageRuleDAO: f.d, hashes: d}
			}
			if _, err := f.s.applyStoppedSourceRecovery(t.Context(), &operationTx{dao: dao}, f.r, in); err == nil {
				t.Fatal("unbounded or unsupported recovery accepted")
			}
			if len(d.recoveries) != 0 {
				t.Fatal("unproven recovery recorded")
			}
		})
	}
}
func TestSourceRecoveryRejectsCorruptStoredReceipt(t *testing.T) {
	f, d, in := recoveryFixture(t)
	tx := &operationTx{dao: d}
	if _, err := f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in); err != nil {
		t.Fatal(err)
	}
	key := f.r.Snapshot.SessionID + "/" + in.RecoveryID
	previous := d.recoveries[key]
	previous.VerifiedThrough--
	d.recoveries[key] = previous
	if _, err := f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in); err == nil {
		t.Fatal("changed receipt accepted")
	}
}
