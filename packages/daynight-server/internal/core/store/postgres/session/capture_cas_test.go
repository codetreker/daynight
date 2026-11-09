package session_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestExternalCaptureWritesCompareExactObservedState(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	resource := uuid.NewString()
	initial := store.SessionCaptureRecord{SessionID: id, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: uuid.NewString(), Revision: "3", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resource}}
	// These are explicit persisted facts from a completed original staging release
	// and a later reservation, without executing the core retry decision here.
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: request.AttemptID, ImageID: request.Occurrence.ImageID, ByteLength: "10"}, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{State: "failed"}, StorageReleased: true})
	})
	save := func(row store.SessionCaptureRecord) error {
		_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row)
		})
		return err
	}
	read := func(want store.SessionCaptureRecord) {
		t.Helper()
		want.Expected = nil
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			loaded, err := d.(store.SessionResourceDAO).SessionCaptureByImage(t.Context(), id, request.Occurrence.ImageID)
			if err == nil && !reflect.DeepEqual(loaded, want) {
				t.Fatalf("capture persisted a different request, receipt, validation or precondition: got=%+v want=%+v", loaded, want)
			}
			return err
		})
	}
	refused := func(row store.SessionCaptureRecord) {
		t.Helper()
		var refusal *model.Fault
		if err := save(row); !errors.As(err, &refusal) || refusal.Code != "resource_conflict" {
			t.Fatalf("capture write did not expose a conflicting precondition: %v", err)
		}
	}
	if err := save(initial); err != nil {
		t.Fatal(err)
	}
	read(initial)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		usage, err := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		if err == nil && (usage.ReservedBytes != sp.MaxImageBytes || usage.ReservedResources != 1) {
			t.Fatal("original released staging lost or doubled the current capture reservation", usage)
		}
		return err
	})
	refused(initial)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Width: 2, Height: 3, FrameCount: 1}
	copying := initial
	copying.Expected = &store.SessionCaptureState{Receipt: initial.Receipt}
	copying.Receipt.State, copying.Receipt.Revision, copying.Validated = "copying", "4", &validated
	if err := save(copying); err != nil {
		t.Fatal("NULL validation precondition did not match", err)
	}
	read(copying)
	refused(copying)
	read(copying)
	committed := copying
	committed.Expected = &store.SessionCaptureState{Receipt: copying.Receipt, Validated: &validated}
	committed.Receipt.State, committed.Receipt.Revision = "committed", "5"
	committed.Receipt.Resource = &sp.Resource{Revision: "1", ResourceID: resource, Status: "available"}
	for _, kind := range []string{"request", "receipt", "validation", "missing"} {
		t.Run(kind, func(t *testing.T) {
			changed := committed
			expected := *committed.Expected
			changed.Expected = &expected
			switch kind {
			case "request":
				changed.Request.Locator.URL = "https://replacement.example/image.png"
			case "receipt":
				changed.Expected.Receipt.Revision = "1"
			case "validation":
				other := validated
				other.Width++
				changed.Expected.Validated = &other
			case "missing":
				changed.Request.CaptureID = uuid.NewString()
			}
			refused(changed)
			read(copying)
		})
	}
	rejected := errors.New("reject capture transaction")
	completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), committed); err != nil {
			return err
		}
		return rejected
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, rejected) {
		t.Fatal("capture rollback lost its outcome or cause", completion, err)
	}
	read(copying)
	if err := save(committed); err != nil {
		t.Fatal("exact receipt and validation precondition did not match", err)
	}
	read(committed)
	for _, identity := range []string{"source", "image", "attempt"} {
		t.Run("unique "+identity, func(t *testing.T) {
			duplicate := initial
			duplicate.Request.CaptureID = uuid.NewString()
			duplicate.Request.Occurrence.ImageID = uuid.NewString()
			duplicate.Request.Occurrence.SourceKey = uuid.NewString()
			duplicate.Request.AttemptID = uuid.NewString()
			switch identity {
			case "source":
				duplicate.Request.Occurrence.SourceKey = request.Occurrence.SourceKey
			case "image":
				duplicate.Request.Occurrence.ImageID = request.Occurrence.ImageID
			case "attempt":
				duplicate.Request.AttemptID = initial.Receipt.AttemptID
			}
			duplicate.Receipt.CaptureID, duplicate.Receipt.AttemptID, duplicate.Receipt.Occurrence = duplicate.Request.CaptureID, duplicate.Request.AttemptID, duplicate.Request.Occurrence
			refused(duplicate)
			read(committed)
		})
	}
}
