package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type capturePolicyDAO struct {
	store.SessionResourceDAO
	t          *testing.T
	old        store.SessionCaptureRecord
	readError  error
	saveError  error
	uploads    map[string]store.SessionUploadRecord
	uploadRead map[string]error
	reads      []string
	proposed   []store.SessionCaptureRecord
}

func (d *capturePolicyDAO) SessionCapture(_ context.Context, session, id string) (store.SessionCaptureRecord, error) {
	if session != d.old.SessionID || id != d.old.Request.CaptureID {
		d.t.Fatal("capture read changed the original identity")
	}
	return d.old, d.readError
}
func (d *capturePolicyDAO) SessionUpload(_ context.Context, session, id string) (store.SessionUploadRecord, error) {
	if session != d.old.SessionID {
		d.t.Fatal("upload read changed Session")
	}
	d.reads = append(d.reads, id)
	if err, ok := d.uploadRead[id]; ok {
		return store.SessionUploadRecord{}, err
	}
	if row, ok := d.uploads[id]; ok {
		return row, nil
	}
	return store.SessionUploadRecord{}, model.ErrNotFound
}
func (d *capturePolicyDAO) SaveSessionCapture(_ context.Context, row store.SessionCaptureRecord) error {
	d.proposed = append(d.proposed, row)
	return d.saveError
}

func capturePolicyRecord() store.SessionCaptureRecord {
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	resource := uuid.NewString()
	return store.SessionCaptureRecord{SessionID: uuid.NewString(), Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resource}}
}

func TestImageCapturePolicyPreservesOriginalRequestAndMonotoneState(t *testing.T) {
	for _, test := range []struct {
		name, before, after string
		changedRequest      bool
		changedValidation   bool
		wantSave            bool
	}{
		{name: "reserve to copy", before: "reserved", after: "copying", wantSave: true},
		{name: "reserve to fail", before: "reserved", after: "failed", wantSave: true},
		{name: "copy to fail", before: "copying", after: "failed", wantSave: true},
		{name: "copy to commit", before: "copying", after: "committed", wantSave: true},
		{name: "copy cannot rewind", before: "copying", after: "reserved"},
		{name: "committed cannot fail", before: "committed", after: "failed"},
		{name: "failed cannot revive", before: "failed", after: "reserved"},
		{name: "original locator", before: "reserved", after: "reserved", changedRequest: true},
		{name: "fixed validation", before: "copying", after: "copying", changedValidation: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			old := capturePolicyRecord()
			old.Receipt.State = test.before
			validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
			if test.before != "reserved" {
				old.Validated = &validated
			}
			row := old
			row.Receipt.State = test.after
			if test.after == "copying" {
				row.Validated = &validated
			}
			if test.changedRequest {
				row.Request.Locator.URL = "https://replacement.example/image.png"
			}
			if test.changedValidation {
				changed := validated
				changed.Width++
				row.Validated = &changed
			}
			d := &capturePolicyDAO{t: t, old: old}
			err := saveImageCapture(t.Context(), d, row)
			if test.wantSave {
				if err != nil || len(d.proposed) != 1 || d.proposed[0].Receipt.Revision != "2" || d.proposed[0].Receipt.State != test.after {
					t.Fatalf("valid capture transition: proposed=%+v err=%v", d.proposed, err)
				}
				if !reflect.DeepEqual(d.proposed[0].Expected, &store.SessionCaptureState{Receipt: old.Receipt, Validated: old.Validated}) || d.proposed[0].Request != old.Request || !reflect.DeepEqual(d.proposed[0].Validated, row.Validated) {
					t.Fatal("capture candidate lost its exact observed write precondition")
				}
			} else {
				var refusal *model.Fault
				if !errors.As(err, &refusal) || refusal.Code != "resource_conflict" || len(d.proposed) != 0 {
					t.Fatalf("invalid transition reached DAO: proposed=%+v err=%v", d.proposed, err)
				}
			}
		})
	}
}

func TestImageCapturePolicyRetryWaitsForOriginalStagingAndNewIdentity(t *testing.T) {
	for _, state := range []string{"old retained", "old released", "old absent", "new occupied", "old read failure", "new read failure", "late attempt", "retry with validation"} {
		t.Run(state, func(t *testing.T) {
			old := capturePolicyRecord()
			old.Receipt.State = "failed"
			row := old
			row.Receipt.State, row.Receipt.AttemptID = "reserved", uuid.NewString()
			d := &capturePolicyDAO{t: t, old: old, uploads: map[string]store.SessionUploadRecord{}, uploadRead: map[string]error{}}
			cause := errors.New("capture upload read failed")
			switch state {
			case "old retained":
				d.uploads[old.Receipt.AttemptID] = store.SessionUploadRecord{SessionID: old.SessionID, Spec: sp.ImageUploadSpec{UploadID: old.Receipt.AttemptID}}
			case "old released":
				d.uploads[old.Receipt.AttemptID] = store.SessionUploadRecord{SessionID: old.SessionID, Spec: sp.ImageUploadSpec{UploadID: old.Receipt.AttemptID}, StorageReleased: true}
			case "new occupied":
				d.uploads[row.Receipt.AttemptID] = store.SessionUploadRecord{SessionID: old.SessionID, Spec: sp.ImageUploadSpec{UploadID: row.Receipt.AttemptID}, StorageReleased: true}
			case "old read failure":
				d.uploadRead[old.Receipt.AttemptID] = cause
			case "new read failure":
				d.uploadRead[row.Receipt.AttemptID] = cause
			case "late attempt":
				old.Receipt.State = "reserved"
				d.old = old
			case "retry with validation":
				row.Validated = &sp.ValidatedImage{Width: 2}
			}
			err := saveImageCapture(t.Context(), d, row)
			allowed := state == "old released" || state == "old absent"
			if allowed {
				if err != nil || len(d.proposed) != 1 || d.proposed[0].Request != old.Request || d.proposed[0].Receipt.AttemptID != row.Receipt.AttemptID || d.proposed[0].Receipt.Revision != "2" || !reflect.DeepEqual(d.reads, []string{old.Receipt.AttemptID, row.Receipt.AttemptID}) {
					t.Fatalf("original retry lost its request, attempt or staging checks: proposed=%+v reads=%v err=%v", d.proposed, d.reads, err)
				}
				if !reflect.DeepEqual(d.proposed[0].Expected, &store.SessionCaptureState{Receipt: old.Receipt, Validated: old.Validated}) {
					t.Fatal("retry candidate lost its original receipt and validation precondition")
				}
			} else if err == nil || len(d.proposed) != 0 {
				t.Fatalf("ineligible retry reached DAO: proposed=%+v err=%v", d.proposed, err)
			}
			if (state == "old read failure" || state == "new read failure") && !errors.Is(err, cause) {
				t.Fatalf("upload read error hidden: %v", err)
			}
		})
	}
}

func TestImageCapturePolicyInitialWriteExactRetryAndStorageFailures(t *testing.T) {
	for _, state := range []string{"initial", "reserved replay", "copying replay", "committed replay", "failed replay", "read failure", "save failure"} {
		t.Run(state, func(t *testing.T) {
			old := capturePolicyRecord()
			row := old
			cause := errors.New("capture state storage failed")
			d := &capturePolicyDAO{t: t, old: old}
			switch state {
			case "initial":
				row.Receipt.Revision = ""
				row.Expected = &store.SessionCaptureState{Receipt: old.Receipt}
				d.readError = model.ErrNotFound
			case "read failure":
				d.readError = cause
			case "save failure":
				row.Receipt.State = "failed"
				d.saveError = cause
			default:
				row.Receipt.State = state[:len(state)-len(" replay")]
				d.old = row
			}
			err := saveImageCapture(t.Context(), d, row)
			switch state {
			case "initial":
				if err != nil || len(d.proposed) != 1 || d.proposed[0].Expected != nil || d.proposed[0].Receipt.Revision != "1" {
					t.Fatalf("initial capture did not require absence: proposed=%+v err=%v", d.proposed, err)
				}
			case "read failure", "save failure":
				if !errors.Is(err, cause) || state == "read failure" && len(d.proposed) != 0 {
					t.Fatalf("storage failure was hidden or continued: proposed=%+v err=%v", d.proposed, err)
				}
			default:
				if err != nil || len(d.proposed) != 0 || len(d.reads) != 0 {
					t.Fatalf("exact retry changed its revision or touched upload state: proposed=%+v err=%v", d.proposed, err)
				}
			}
		})
	}
}
