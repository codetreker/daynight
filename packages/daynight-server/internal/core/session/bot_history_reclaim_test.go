package session

import (
	"context"
	"errors"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type botReclaimDAO struct {
	*imageRuleDAO
	store.BotHistoryWindowDAO
	queued     map[string]bool
	checkpoint []byte
}

func (d *botReclaimDAO) BotHistoryCheckpoint(context.Context, string) ([]byte, error) {
	return d.checkpoint, nil
}
func (d *botReclaimDAO) QueueBotHistoryReclaim(_ context.Context, _, id string) error {
	d.queued[id] = true
	return nil
}
func (d *botReclaimDAO) PendingBotHistoryReclaims(context.Context, string) ([]string, error) {
	out := []string{}
	for id := range d.queued {
		out = append(out, id)
	}
	return out, nil
}
func (d *botReclaimDAO) CompleteBotHistoryReclaim(_ context.Context, _, id string) error {
	delete(d.queued, id)
	return nil
}
func (d *botReclaimDAO) SessionResourceReferences(_ context.Context, id, kind string) ([]store.SessionResourceReference, error) {
	out := []store.SessionResourceReference{}
	for ref := range d.references {
		if ref.SessionID == id && ref.Kind == kind {
			out = append(out, ref)
		}
	}
	return out, nil
}

func TestBotWindowReferenceReplacementPreservesIndependentOwners(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{}}
	in := checkpointFixture()
	in.ControllerFence = f.r.Snapshot.ControllerFence
	resource, evicted, pending := uuid.NewString(), uuid.NewString(), uuid.NewString()
	entry, pendingEntry := in.Entries[0].EntryID, uuid.NewString()
	in.Entries[0].ResourceIDs = []string{resource}
	f.r.Live.PendingInteractions = map[string]sp.TimelineEntry{pendingEntry: {EntryID: pendingEntry, Kind: "interaction"}}
	for _, v := range []struct{ id, entry string }{{resource, entry}, {evicted, uuid.NewString()}, {pending, pendingEntry}} {
		d.resources[v.id] = store.SessionResourceRecord{SessionID: in.SessionID, Resource: sp.Resource{ResourceID: v.id, Status: "available"}}
		imageID, captureID := uuid.NewString(), uuid.NewString()
		d.captures[captureID] = store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{CaptureID: captureID, Occurrence: sp.ImageOccurrence{ImageID: imageID, EntryID: v.entry}}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &v.id}}
		d.references[store.SessionResourceReference{SessionID: in.SessionID, ResourceID: v.id, Kind: "message", ReferenceID: imageID}] = true
	}
	operation := store.SessionResourceReference{SessionID: in.SessionID, ResourceID: evicted, Kind: "operation", ReferenceID: uuid.NewString()}
	d.references[operation] = true
	oldWindow := store.SessionResourceReference{SessionID: in.SessionID, ResourceID: evicted, Kind: "bot_window", ReferenceID: uuid.NewString()}
	d.references[oldWindow] = true
	if err := f.s.replaceBotWindowReferences(t.Context(), &operationTx{dao: d}, f.r, in); err != nil {
		t.Fatal(err)
	}
	if !d.references[operation] || d.references[oldWindow] || !d.queued[evicted] || d.queued[pending] {
		t.Fatal("wrong ownership replacement", d.references, d.queued)
	}
	if !d.references[store.SessionResourceReference{SessionID: in.SessionID, ResourceID: resource, Kind: "bot_window", ReferenceID: entry}] {
		t.Fatal("new closure not pinned")
	}
	for ref := range d.references {
		if ref.Kind == "message" && ref.ResourceID != pending {
			t.Fatal("obsolete message pin survived", ref)
		}
	}
}

func TestBotWindowReclaimWaitsForRealFileReaderAndRunsAfterRelease(t *testing.T) {
	f, original := completedReclaimFixture(t)
	bot := uuid.NewString()
	f.r.BotID = &bot
	d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{original.Resource.ResourceID: true}}
	// The completed upload fixture supplies real immutable bytes. The controlled
	// DAO supplies the already released ownership and independent transaction facts.
	d.references = map[store.SessionResourceReference]bool{}
	run := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return work(d, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
	}
	lease := uuid.NewString()
	_, finish, err := f.s.beginImageIO(t.Context(), f.r.Snapshot.SessionID, lease)
	if err != nil {
		t.Fatal(err)
	}
	d.leases[lease] = store.SessionResourceLease{ID: lease, SessionID: f.r.Snapshot.SessionID, ResourceID: original.Resource.ResourceID, Kind: "read"}
	if err = f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, run); err == nil {
		t.Fatal("active reader allowed reclamation")
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, original.BlobPath)
	if err != nil {
		t.Fatal("reader lost file", err)
	}
	_ = object.Body.Close()
	if !d.resources[original.Resource.ResourceID].GCPending || !d.queued[original.Resource.ResourceID] {
		t.Fatal("missing durable pending responsibility")
	}
	f.s.SetBotHistoryReclamation(func(ctx context.Context, id string) error { return f.s.ReclaimBotHistoryResourcesUsing(ctx, id, run) })
	delete(d.leases, lease)
	if err = finish(); err != nil {
		t.Fatal(err)
	}
	object, err = f.files.Open(t.Context(), sessionresource.Bucket, original.BlobPath)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("released reader did not trigger physical cleanup", err)
	}
	if len(d.queued) != 0 || len(d.resources) != 0 {
		t.Fatal("cleanup did not settle ownership")
	}
}

func TestBotWindowReclaimKeepsSharedResourceAndUnknownCommitResponsibility(t *testing.T) {
	f, original := completedReclaimFixture(t)
	bot := uuid.NewString()
	d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{original.Resource.ResourceID: true}}
	run := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return work(d, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
	}
	if err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, run); err != nil {
		t.Fatal(err)
	}
	if !d.queued[original.Resource.ResourceID] || len(d.resources) != 1 {
		t.Fatal("shared original was reclaimed")
	}
	d.references = map[store.SessionResourceReference]bool{}
	cause := errors.New("transaction completion unknown")
	calls := 0
	unknown := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		calls++
		if err := run(ctx, work); err != nil {
			return err
		}
		if calls == 2 {
			return cause
		}
		return nil
	}
	if err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, unknown); !errors.Is(err, cause) {
		t.Fatal(err)
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, original.BlobPath)
	if err != nil {
		t.Fatal("unknown claim deleted file", err)
	}
	_ = object.Body.Close()
}

func TestBotWindowCaptureUsesExactOccurrenceAndRetiresLateCompletion(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	bot := uuid.NewString()
	f.r.BotID = &bot
	f.r.Live.BotHistoryWindowVersion = 1
	in := checkpointFixture()
	in.ControllerFence = f.r.Snapshot.ControllerFence
	f.r.SourceEpoch = &in.SourceEpoch
	f.r.Snapshot.HistoryEpoch = in.HistoryEpoch
	f.r.SourceSeq = 4
	part, revision, digest := uuid.NewString(), "1", hashBytes([]byte("source"))
	occurrence := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: in.Entries[0].EntryID, Container: "content", PartID: &part, SourceRevision: &revision, SourceTextSHA256: &digest, SourceKey: "original"}
	in.Entries[0].ImageOccurrences = []sp.ImageOccurrence{occurrence}
	d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{}, checkpoint: encode(in)}
	tx := &operationTx{dao: d}
	if err := verifyBotWindowImageOccurrence(t.Context(), tx, f.r, occurrence); err != nil {
		t.Fatal(err)
	}
	changed := occurrence
	changed.SourceKey = "changed"
	if err := verifyBotWindowImageOccurrence(t.Context(), tx, f.r, changed); err == nil {
		t.Fatal("wrong source admitted")
	}
	resource := uuid.NewString()
	capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: occurrence}}
	if retired, err := retireEvictedBotCapture(t.Context(), tx, f.r, capture, resource); err != nil || retired {
		t.Fatal(retired, err)
	}
	in.Entries = in.Entries[1:]
	in.RetainedFromSeq = &in.Entries[0].EntrySeq
	in.WindowRevision = "3"
	d.checkpoint = encode(in)
	if retired, err := retireEvictedBotCapture(t.Context(), tx, f.r, capture, resource); err != nil || !retired || !d.queued[resource] {
		t.Fatal(retired, err, d.queued)
	}
}

func TestBotWindowEvictionPreservesLostCaptureReceiptRecovery(t *testing.T) {
	for _, mode := range []string{"legacy", "relay"} {
		t.Run(mode, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			bot := uuid.NewString()
			f.r.BotID, f.r.OnlineMode, f.r.Live.BotHistoryWindowVersion = &bot, mode, 1
			in := checkpointFixture()
			in.ControllerFence = f.r.Snapshot.ControllerFence
			in.Entries = []sp.BotHistoryCheckpointEntry{}
			in.RetainedFromSeq = nil
			f.r.Snapshot.HistoryEpoch, f.r.SourceSeq = in.HistoryEpoch, 4
			d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{}, checkpoint: encode(in)}
			resource := uuid.NewString()
			request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: sp.ImageLocator{Kind: "resource", ResourceID: resource}}
			original := store.SessionCaptureRecord{SessionID: f.r.Snapshot.SessionID, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "2", Occurrence: request.Occurrence, State: "committed", ResourceID: &resource}}
			d.captures[request.CaptureID] = original
			submission := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "resource"}}
			out, err := f.s.submitImageCapture(t.Context(), &operationTx{dao: d}, f.r, d, submission)
			if err != nil || !jsonEqual(encode(out.Receipt), encode(original.Receipt)) {
				t.Fatal("eviction hid accepted capture outcome", out, err)
			}
			if len(d.references) != 0 || len(d.queued) != 0 {
				t.Fatal("receipt recovery recreated ownership")
			}
		})
	}
}

func TestBotWindowReclamationFailureDoesNotReplaceCompletedIO(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	calls := 0
	f.s.SetBotHistoryReclamation(func(context.Context, string) error { calls++; return errors.New("another resource deletion failed") })
	_, finish, err := f.s.beginImageIO(t.Context(), f.r.Snapshot.SessionID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if err = finish(); err != nil || calls != 1 {
		t.Fatal("independent reclamation replaced the I/O result", err, calls)
	}
}

func TestBotWindowPhysicalReclamationFailureRetainsQueueAndQuota(t *testing.T) {
	f, original := completedReclaimFixture(t)
	bot := uuid.NewString()
	d := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{original.Resource.ResourceID: true}}
	d.references = map[store.SessionResourceReference]bool{}
	run := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return work(d, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
	}
	cause := errors.New("physical deletion failed")
	f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: cause}
	if err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, run); !errors.Is(err, cause) {
		t.Fatal(err)
	}
	if !d.queued[original.Resource.ResourceID] || !d.resources[original.Resource.ResourceID].GCPending {
		t.Fatal("failed deletion lost responsibility")
	}
	f.s.files = f.files
	if err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, run); err != nil {
		t.Fatal(err)
	}
	if len(d.queued) != 0 || len(d.resources) != 0 {
		t.Fatal("retry did not settle physical deletion")
	}
}
