package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type botClosureCheckpointDAO struct {
	*botReclaimDAO
	read func(context.Context, string) ([]byte, error)
	save func(context.Context, string, []byte) error
}

func TestBotWindowImageClosureIsCheckedBeforeAnyReferenceMutation(t *testing.T) {
	for _, kind := range []string{"complete", "unregistered", "wrapped missing", "read failure", "joined missing failure", "reserved", "copying", "different occurrence", "missing resource", "missing receipt resource", "empty receipt resource", "pending missing resource"} {
		t.Run(kind, func(t *testing.T) {
			ctx := t.Context()
			in := checkpointFixture()
			resource, other := uuid.NewString(), uuid.NewString()
			occurrence := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: in.Entries[1].EntryID, Container: "content", SourceKey: "original"}
			// An earlier entry would already be pinned if closure validation were interleaved.
			in.Entries[0].ResourceIDs = []string{other}
			in.Entries[1].ImageOccurrences = []sp.ImageOccurrence{occurrence}
			capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: occurrence}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}
			r := &record{Live: &liveSession{PendingInteractions: map[string]sp.TimelineEntry{}}}
			cause := errors.New("capture storage unavailable")
			var lookupError error
			refused := false
			switch kind {
			case "complete":
				in.Entries[1].ResourceIDs = []string{resource}
			case "unregistered":
				lookupError = model.ErrNotFound
			case "wrapped missing":
				lookupError = fmt.Errorf("lookup: %w", model.ErrNotFound)
			case "read failure":
				lookupError, refused = cause, true
			case "joined missing failure":
				lookupError, refused = errors.Join(model.ErrNotFound, cause), true
			case "reserved", "copying":
				capture.Receipt.State = kind
			case "different occurrence":
				capture.Request.Occurrence.SourceKey = "previous image source"
			case "missing receipt resource":
				capture.Receipt.ResourceID, refused = nil, true
			case "empty receipt resource":
				empty := ""
				capture.Receipt.ResourceID, refused = &empty, true
			case "pending missing resource":
				r.Live.PendingInteractions[occurrence.EntryID] = sp.TimelineEntry{EntryID: occurrence.EntryID, Kind: "interaction"}
				refused = true
			case "missing resource":
				refused = true
			}
			lookups, pins, references := 0, 0, 0
			dao := &checkpointRuleDAO{capture: func(actual context.Context, session, image string) (store.SessionCaptureRecord, error) {
				lookups++
				if actual != ctx || session != in.SessionID || image != occurrence.ImageID || lookups != 1 || pins != 0 {
					t.Fatal("closure lookup escaped its original scope or followed a write")
				}
				return capture, lookupError
			}, resource: func(actual context.Context, session, id string) (store.SessionResourceRecord, error) {
				if refused || actual != ctx || session != in.SessionID || id != other && id != resource {
					t.Fatal("invalid closure reached resource admission")
				}
				return store.SessionResourceRecord{Resource: sp.Resource{ResourceID: id, Status: "available"}}, nil
			}, add: func(actual context.Context, ref store.SessionResourceReference) error {
				pins++
				if refused || actual != ctx || ref.SessionID != in.SessionID || ref.Kind != "bot_window" {
					t.Fatal("invalid closure changed reference ownership")
				}
				return nil
			}, refs: func(actual context.Context, session, referenceKind string) ([]store.SessionResourceReference, error) {
				references++
				if refused || actual != ctx || session != in.SessionID || referenceKind != "bot_window" && referenceKind != "message" {
					t.Fatal("invalid closure reached old ownership")
				}
				return []store.SessionResourceReference{}, nil
			}}
			err := (&Execution{}).replaceBotWindowReferences(ctx, &operationTx{dao: dao}, r, in)
			if lookupError != nil && refused {
				if !errors.Is(err, cause) {
					t.Fatal("closure lookup lost its failure", err)
				}
			} else if refused {
				botFault(t, err, "resource_conflict")
			} else if err != nil {
				t.Fatal(err)
			}
			wantPins, wantReferences := 1, 2
			if kind == "complete" {
				wantPins = 2
			}
			if refused {
				wantPins, wantReferences = 0, 0
			}
			if lookups != 1 || pins != wantPins || references != wantReferences {
				t.Fatal("unexpected closure operations", lookups, pins, references)
			}
		})
	}
}

func (d *botClosureCheckpointDAO) BotHistoryCheckpoint(ctx context.Context, id string) ([]byte, error) {
	return d.read(ctx, id)
}

func (d *botClosureCheckpointDAO) SaveBotHistoryCheckpoint(ctx context.Context, id string, raw []byte) error {
	return d.save(ctx, id, raw)
}

func TestBotWindowSecondCheckpointCannotDropRetainedImageOriginal(t *testing.T) {
	f, original := completedReclaimFixture(t)
	ctx := t.Context()
	checkpoint := checkpointFixture()
	checkpoint.ControllerFence = f.r.Snapshot.ControllerFence
	bot, token, resource := uuid.NewString(), "original-controller", original.Resource.ResourceID
	hash := sha256.Sum256([]byte(token))
	f.r.BotID, f.r.GrantHash, f.r.SourceEpoch, f.r.SourceSeq = &bot, hash[:], &checkpoint.SourceEpoch, 4
	f.r.Snapshot.HistoryEpoch = checkpoint.HistoryEpoch
	f.r.Live.BotHistoryWindowVersion = 1
	occurrence := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: checkpoint.Entries[0].EntryID, Container: "content", SourceKey: "original"}
	checkpoint.Entries[0].ImageOccurrences = []sp.ImageOccurrence{occurrence}
	checkpoint.Entries[0].ResourceIDs = []string{resource}
	captureID := uuid.NewString()
	f.d.captures[captureID] = store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{CaptureID: captureID, Occurrence: occurrence}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}
	message := store.SessionResourceReference{SessionID: checkpoint.SessionID, ResourceID: resource, Kind: "message", ReferenceID: occurrence.ImageID}
	window := store.SessionResourceReference{SessionID: checkpoint.SessionID, ResourceID: resource, Kind: "bot_window", ReferenceID: occurrence.EntryID}
	// The completed original is already owned by its committed capture.
	f.d.references = map[store.SessionResourceReference]bool{message: true}
	var savedFact, proposed []byte
	writes := 0
	dao := &botClosureCheckpointDAO{botReclaimDAO: &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{}}, read: func(actual context.Context, id string) ([]byte, error) {
		if actual != ctx || id != checkpoint.SessionID {
			t.Fatal("checkpoint read changed Session")
		}
		if savedFact == nil {
			return nil, model.ErrNotFound
		}
		return savedFact, nil
	}, save: func(actual context.Context, id string, raw []byte) error {
		if actual != ctx || id != checkpoint.SessionID {
			t.Fatal("checkpoint write changed Session")
		}
		writes++
		proposed = append([]byte{}, raw...)
		return nil
	}}
	f.s.controllerRun = func(actual context.Context, fence sp.ControllerFence, work func(*Access) error) error {
		if actual != ctx || fence != checkpoint.ControllerFence {
			t.Fatal("checkpoint authority changed")
		}
		return work(&Access{tx: &operationTx{dao: dao}, record: f.r})
	}
	if _, err := f.s.CommitBotHistoryCheckpoint(ctx, token, checkpoint); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || !jsonEqual(proposed, encode(checkpoint)) || f.d.references[message] || !f.d.references[window] {
		t.Fatal("first publication did not transfer the committed image into the window")
	}
	// The next transaction reads the independently confirmed first checkpoint.
	savedFact = encode(checkpoint)
	next, err := sp.DecodeBotHistoryCheckpoint(encode(checkpoint))
	if err != nil {
		t.Fatal(err)
	}
	next.WindowRevision, next.Entries[0].Revision = "3", "2"
	next.Entries[0].ResourceIDs = []string{}
	_, err = f.s.CommitBotHistoryCheckpoint(ctx, token, next)
	botFault(t, err, "resource_conflict")
	if writes != 1 || !f.d.references[window] || f.d.references[message] {
		t.Fatal("rejected second publication changed the original pin or checkpoint")
	}
	reclaim := func(actual context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return work(dao, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
	}
	if err := f.s.ReclaimBotHistoryResourcesUsing(ctx, checkpoint.SessionID, reclaim); err != nil {
		t.Fatal(err)
	}
	assertReclaimRetainsOriginal(t, f, original)
	// Evicting the occurrence itself may release the original once no owner remains.
	next.Entries = next.Entries[1:]
	next.RetainedFromSeq = &next.Entries[0].EntrySeq
	if _, err := f.s.CommitBotHistoryCheckpoint(ctx, token, next); err != nil {
		t.Fatal("legitimate eviction was refused", err)
	}
	if writes != 2 || f.d.references[window] {
		t.Fatal("legitimate eviction retained its old display pin")
	}
	if err := f.s.ReclaimBotHistoryResourcesUsing(ctx, checkpoint.SessionID, reclaim); err != nil {
		t.Fatal(err)
	}
	object, err := f.files.Open(ctx, sessionresource.Bucket, original.BlobPath)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) || len(f.d.resources) != 0 || len(dao.queued) != 0 {
		t.Fatal("legitimate eviction did not settle the original", err)
	}
}
