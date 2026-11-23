package session_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaptureInventoryPagesCompleteOriginalRecords(t *testing.T) {
	db := isolatedStore(t)
	id, other := uuid.NewString(), uuid.NewString()
	ids := []string{"10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"}
	makeCapture := func(session, capture string) store.SessionCaptureRecord {
		request := sp.ImageCaptureRequest{CaptureID: capture, AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://example.test/image"}}
		return store.SessionCaptureRecord{SessionID: session, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: capture, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "failed", Error: &sp.ImageError{Code: "source_not_found", Message: "Missing."}}}
	}
	want := []store.SessionCaptureRecord{makeCapture(id, ids[0]), makeCapture(id, ids[1]), makeCapture(id, ids[2])}
	want[1].Validated = &sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Width: 2, Height: 3, FrameCount: 1}
	otherRow := makeCapture(other, ids[1])
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		for _, row := range []store.SessionCaptureRecord{want[2], otherRow, want[0], want[1]} {
			if err := dao.(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row); err != nil {
				return err
			}
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		inventory := dao.(store.SessionCaptureInventoryDAO)
		first, err := inventory.SessionCaptures(t.Context(), id, "", 2)
		if err != nil || !reflect.DeepEqual(first, want[:2]) {
			t.Fatalf("first page: got=%+v want=%+v error=%v", first, want[:2], err)
		}
		last, err := inventory.SessionCaptures(t.Context(), id, first[1].Request.CaptureID, 2)
		if err != nil || !reflect.DeepEqual(last, want[2:]) {
			t.Fatalf("last page: got=%+v want=%+v error=%v", last, want[2:], err)
		}
		empty, err := inventory.SessionCaptures(t.Context(), id, ids[2], 2)
		if err != nil || len(empty) != 0 {
			t.Fatalf("end page: got=%+v error=%v", empty, err)
		}
		for _, limit := range []int{0, 1001} {
			if rows, err := inventory.SessionCaptures(t.Context(), id, "", limit); err == nil || rows != nil {
				t.Fatalf("invalid limit %d: %+v %v", limit, rows, err)
			}
		}
		return nil
	})

	// An invalid persisted row cannot return the preceding rows as a complete page.
	mustQueryExec(t, db, `UPDATE session_image_captures SET request=jsonb_set(request,'{captureId}','"invalid"'::jsonb) WHERE session_id=$1 AND capture_id=$2`, id, ids[1])
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		rows, err := dao.(store.SessionCaptureInventoryDAO).SessionCaptures(t.Context(), id, "", 3)
		if err == nil || rows != nil {
			t.Fatalf("corrupt key returned partial inventory: %+v %v", rows, err)
		}
		return nil
	})

	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if rows, err := pgsession.New(tx).(store.SessionCaptureInventoryDAO).SessionCaptures(context.Background(), id, "", 2); !errors.Is(err, pgx.ErrTxClosed) || rows != nil {
		t.Fatalf("closed transaction: %+v %v", rows, err)
	}
}
