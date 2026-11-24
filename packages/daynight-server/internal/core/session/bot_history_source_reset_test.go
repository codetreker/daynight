package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type botWindowSourceResetDAO struct {
	*checkpointRuleDAO
	touch func(context.Context, string, time.Time) error
	state func(context.Context, store.SessionRecord) error
}

func TestBotWindowSourceResetDefersCaptureWithoutLosingOriginalUpload(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	request := directCaptureFixture(t, f)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "validated", Validated: &validated}}
	if _, err := directCaptureCall(t, f, input); err != nil {
		t.Fatal(err)
	}
	capture := f.d.captures[request.CaptureID]
	cp := checkpointFixture()
	cp.ControllerFence = f.r.Snapshot.ControllerFence
	cp.Entries[0].ImageOccurrences = []sp.ImageOccurrence{request.Occurrence}
	cp.Entries[0].EntryID = request.Occurrence.EntryID
	bot, currentSource := uuid.NewString(), uuid.NewString()
	f.r.BotID, f.r.SourceEpoch, f.r.Live.BotHistoryWindowVersion = &bot, &currentSource, 1
	f.r.Snapshot.HistoryEpoch, f.r.SourceSeq = cp.HistoryEpoch, 4
	dao := &botReclaimDAO{imageRuleDAO: f.d, checkpoint: encode(cp), queued: map[string]bool{}}
	previousBrowser := f.s.browserRun
	f.s.browserRun = func(ctx context.Context, p model.Principal, project, task, id string, purpose BrowserPurpose, work func(*Access) error) error {
		return previousBrowser(ctx, p, project, task, id, purpose, func(a *Access) error {
			a.tx.dao = dao
			return work(a)
		})
	}
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		row.Complete = true
		row.Result = encode(sp.PreparedImageChunk{PreparationID: request.AttemptID, ByteLength: validated.ByteLength, SHA256: validated.SHA256, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
		return row
	}
	err := f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, capture)
	botFault(t, err, "history_unavailable")
	if imageFailureEvidence(err) != nil || f.d.captures[request.CaptureID].Receipt.State != "copying" {
		t.Fatal("source handoff became a permanent capture failure", err)
	}
	resource := *capture.Receipt.ResourceID
	uploadRef := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: resource, Kind: "upload", ReferenceID: request.AttemptID}
	messageRef := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: resource, Kind: "message", ReferenceID: request.Occurrence.ImageID}
	if !f.d.references[uploadRef] || f.d.references[messageRef] || len(dao.queued) != 0 {
		t.Fatal("source handoff changed display ownership or lost upload responsibility")
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, f.d.resources[resource].BlobPath)
	if err != nil {
		t.Fatal("deferred capture lost immutable original", err)
	}
	got, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(got) != string(raw) {
		t.Fatal("deferred original changed", readErr, closeErr)
	}
	cp.SourceEpoch = currentSource
	dao.checkpoint = encode(cp)
	if err := f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, capture); err != nil {
		t.Fatal("rebound checkpoint did not resume original capture", err)
	}
	if f.d.captures[request.CaptureID].Receipt.State != "committed" || f.d.references[uploadRef] || !f.d.references[messageRef] || len(f.d.resources) != 1 || len(f.d.uploads) != 1 {
		t.Fatal("capture retry duplicated the original or failed to transfer responsibility")
	}
}

func (d *botWindowSourceResetDAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	return d.touch(ctx, id, now)
}

func (d *botWindowSourceResetDAO) SaveSession(ctx context.Context, r store.SessionRecord) error {
	return d.state(ctx, r)
}

func TestBotWindowSourceResetCannotReviveCheckpointAtReusedWatermark(t *testing.T) {
	ctx := t.Context()
	old := checkpointFixture()
	oldSource, newSource := old.SourceEpoch, uuid.NewString()
	bot, token := uuid.NewString(), "original-controller"
	hash := sha256.Sum256([]byte(token))
	occurrence := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: old.Entries[0].EntryID, Container: "content", SourceKey: "image"}
	old.Entries[0].ImageOccurrences = []sp.ImageOccurrence{occurrence}
	r := &record{
		BotID: &bot, GrantHash: hash[:], SourceEpoch: &oldSource, SourceEpochs: []string{oldSource}, SourceSeq: 4,
		Snapshot: sp.Snapshot{ControllerFence: old.ControllerFence, HistoryEpoch: old.HistoryEpoch, Lifecycle: "active", LastEventSeq: "0"},
		Live:     &liveSession{BotHistoryWindowVersion: 1, SourceHashes: map[int64][32]byte{}, BatchHashes: map[string][32]byte{}},
	}
	stored := encode(old)
	reads, referenceReads, writes, touches, saves := 0, 0, 0, 0, 0
	dao := &botWindowSourceResetDAO{checkpointRuleDAO: &checkpointRuleDAO{
		capture: func(actual context.Context, id, image string) (store.SessionCaptureRecord, error) {
			if actual != ctx || id != old.SessionID || image != occurrence.ImageID {
				t.Fatal("capture lookup changed authority")
			}
			return store.SessionCaptureRecord{}, model.ErrNotFound
		},
		read: func(actual context.Context, id string) ([]byte, error) {
			reads++
			if actual != ctx || id != old.SessionID {
				t.Fatal("checkpoint read changed authority")
			}
			return stored, nil
		},
		refs: func(actual context.Context, id, kind string) ([]store.SessionResourceReference, error) {
			referenceReads++
			if actual != ctx || id != old.SessionID || kind != "bot_window" && kind != "message" {
				t.Fatal("checkpoint references changed authority")
			}
			return []store.SessionResourceReference{}, nil
		},
		save: func(actual context.Context, id string, raw []byte) error {
			writes++
			got, err := sp.DecodeBotHistoryCheckpoint(raw)
			if actual != ctx || id != old.SessionID || err != nil || got.SourceEpoch != newSource || got.SourceThrough != "4" || got.WindowRevision != old.WindowRevision {
				t.Fatal("publication did not preserve the logical checkpoint", got, err)
			}
			return nil
		},
	}, touch: func(actual context.Context, id string, now time.Time) error {
		touches++
		if actual != ctx || id != old.SessionID || now.IsZero() {
			t.Fatal("source transition touched another Session")
		}
		return nil
	}, state: func(actual context.Context, got store.SessionRecord) error {
		saves++
		if actual != ctx || got.SourceEpoch == nil || *got.SourceEpoch != newSource || got.Snapshot.ControllerFence != old.ControllerFence || got.Snapshot.HistoryEpoch != old.HistoryEpoch {
			t.Fatal("source reset changed the logical history or fence")
		}
		return nil
	}}
	tx := &operationTx{dao: dao}
	s := &Execution{Engine: NewEngine(nil)}
	s.controllerRun = func(actual context.Context, fence sp.ControllerFence, work func(*Access) error) error {
		if actual != ctx || fence != old.ControllerFence {
			t.Fatal("controller authority changed")
		}
		return work(&Access{tx: tx, record: r})
	}
	if _, err := readBotHistoryCheckpoint(ctx, tx, r); err != nil {
		t.Fatal("initial checkpoint was unavailable", err)
	}
	if _, err := s.Handle(ctx, sp.ControllerMessage{Type: "source_reset", ControllerFence: old.ControllerFence, PreviousSourceEpoch: oldSource, NewSourceEpoch: newSource, Reason: "provider resumed"}); err != nil {
		t.Fatal(err)
	}
	if r.SourceSeq != 0 || sourceEpoch(r) != newSource {
		t.Fatal("real source reset did not restart its counter")
	}
	for i := int64(1); i <= 4; i++ {
		if _, err := s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: old.ControllerFence, SourceEpoch: newSource, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(i), Kind: "gap", Payload: []byte(`{"reason":"new source event"}`)}}}); err != nil {
			t.Fatal(err)
		}
	}
	if r.SourceSeq != 4 || touches != 5 || saves != 5 {
		t.Fatal("new source did not reach the old watermark", r.SourceSeq, touches, saves)
	}
	_, err := readBotHistoryCheckpoint(ctx, tx, r)
	botFault(t, err, "history_unavailable")
	botFault(t, verifyBotWindowImageOccurrence(ctx, tx, r, occurrence), "history_unavailable")
	readBefore := reads
	_, err = s.CommitBotHistoryCheckpoint(ctx, token, old)
	botFault(t, err, "reset_required")
	if reads != readBefore || referenceReads != 0 || writes != 0 {
		t.Fatal("late old checkpoint reached ownership replacement", reads, referenceReads, writes)
	}
	capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: occurrence}}
	retired, err := retireEvictedBotCapture(ctx, tx, r, capture, uuid.NewString())
	botFault(t, err, "history_unavailable")
	if retired {
		t.Fatal("source reset was treated as display eviction")
	}
	current := old
	current.SourceEpoch = newSource
	receipt, err := s.CommitBotHistoryCheckpoint(ctx, token, current)
	if err != nil || receipt.SourceEpoch != newSource || receipt.WindowRevision != old.WindowRevision || referenceReads != 2 || writes != 1 {
		t.Fatal("current source could not rebind the same logical checkpoint", receipt, err, referenceReads, writes)
	}
	// Supply the independently confirmed read fact; the mock write is not persistence.
	stored = encode(current)
	if _, err := readBotHistoryCheckpoint(ctx, tx, r); err != nil {
		t.Fatal("rebound checkpoint was unavailable", err)
	}
	if err := verifyBotWindowImageOccurrence(ctx, tx, r, occurrence); err != nil {
		t.Fatal("rebound occurrence was unavailable", err)
	}
}
