package session_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestMediaPayloadRepresentationRewriteUsesExactObservedState(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	upload, resource := uuid.NewString(), uuid.NewString()
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "write", Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Body: []byte(`{"uploadId":"` + upload + `","data":"b3JpZ2luYWw=","offset":"0","sha256":"digest"}`)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	var observed store.SessionMediaRequest
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		var err error
		observed, err = base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, row.RequestID)
		return err
	})
	rewritten := observed
	rewritten.Expected = &store.SessionMediaState{Fence: observed.Fence, Body: observed.Body, Result: observed.Result, Error: observed.Error, Complete: observed.Complete}
	rewritten.Body = []byte(`{"uploadId":"` + upload + `","offset":"0","sha256":"digest","$data":{"sha256":"digest","byteLength":8}}`)
	rollback := errors.New("rollback compact representation")
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), rewritten); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, row.RequestID)
		if err == nil && !bytes.Contains(got.Body, []byte(`"data"`)) {
			t.Fatal("rollback published compact body")
		}
		return err
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), rewritten)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		if bytes.Contains(got.Body, []byte(`"data"`)) || got.Complete || got.Expected != nil {
			t.Fatal("payload rewrite did not persist only the intended state", string(got.Body))
		}
		// Replaying the same rewrite is stale: the old full-body representation
		// no longer exists, even though its request identity is unchanged.
		err = d.SaveSessionMediaRequest(t.Context(), rewritten)
		var conflict *model.Fault
		if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
			t.Fatal("stale observed CAS succeeded", err)
		}
		return nil
	})
	// The optional query includes exact upload, capture/preparation and resource
	// owners and excludes unrelated rows in the same Session.
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		for _, body := range []string{`{"attemptId":"` + upload + `"}`, `{"preparationId":"` + upload + `"}`, `{"resourceId":"` + resource + `"}`, `{"uploadId":"` + uuid.NewString() + `"}`} {
			next := row
			next.RequestID = uuid.NewString()
			next.Action = "read_capture"
			next.Body = []byte(body)
			if err := d.SaveSessionMediaRequest(t.Context(), next); err != nil {
				return err
			}
		}
		rows, err := base.(store.SessionUploadMediaDAO).SessionUploadMediaRequests(t.Context(), id, upload, resource)
		if err == nil && len(rows) != 4 {
			t.Fatal("upload media query crossed identity boundaries", len(rows))
		}
		return err
	})
}

func TestCompletedReadPayloadRewritePersistsBoundedReceiptAndRejectsChangedResult(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "read_capture", Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Body: []byte(`{"attemptId":"` + uuid.NewString() + `"}`), Complete: true, Result: []byte(`{"data":"b3JpZ2luYWw=","offset":"0"}`)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	var compact store.SessionMediaRequest
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		compact = got
		compact.Expected = &store.SessionMediaState{Fence: got.Fence, Body: got.Body, Result: got.Result, Complete: true}
		compact.Result = []byte(`{"$data":{"sha256":"digest","byteLength":8},"offset":"0"}`)
		return d.SaveSessionMediaRequest(t.Context(), compact)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		if bytes.Contains(got.Result, []byte(`"data"`)) || !got.Complete || len(got.Result) > 128 {
			t.Fatal("completed receipt retained original bytes")
		}
		compact.Expected = &store.SessionMediaState{Fence: got.Fence, Body: got.Body, Result: got.Result, Error: got.Error, Complete: got.Complete}
		got.Result = []byte(`{"different":"receipt"}`)
		if err = d.SaveSessionMediaRequest(t.Context(), got); err == nil {
			t.Fatal("completed receipt was mutable without observed CAS")
		}
		return nil
	})
	// A stale body, result, error, completion or connection epoch must each fail.
	for _, field := range []string{"body", "result", "error", "complete", "epoch"} {
		t.Run(field, func(t *testing.T) {
			changed := compact
			expected := *compact.Expected
			changed.Expected = &expected
			switch field {
			case "body":
				expected.Body = []byte(`{}`)
			case "result":
				expected.Result = []byte(`{}`)
			case "error":
				expected.Error = &sp.ImageError{Code: "changed", Message: "changed"}
			case "complete":
				expected.Complete = false
			case "epoch":
				expected.Fence.ConnectionEpoch = "2"
			}
			_, err := db.WriteSession(context.Background(), func(scope store.SessionScope) error {
				return scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), changed)
			})
			var conflict *model.Fault
			if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
				t.Fatal("changed observed field was accepted", field, err)
			}
		})
	}
}

func TestUnpublishedUploadMediaLeaseUsesWildcardUntilResourceExists(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), ByteLength: "8"}, Receipt: sp.ImageUploadReceipt{State: "verifying", AcceptedOffset: "8"}, ExpiresAt: time.Now().Add(time.Hour)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		if _, err := d.SessionResourceUsage(t.Context(), id); err != nil {
			return err
		}
		return d.SaveSessionUpload(t.Context(), upload)
	})
	lease := store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), OwnerID: actor.UserID, Kind: "read"}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), lease)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		rows, err := d.ListSessionResourceLeases(t.Context(), id)
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0].ID != lease.ID || rows[0].ResourceID != "" {
			t.Fatal("unpublished media owner did not persist wildcard lease", rows)
		}
		if _, err = d.SavedSessionResource(t.Context(), id, upload.BlobID); !errors.Is(err, model.ErrNotFound) {
			t.Fatal("pending upload unexpectedly required a published resource", err)
		}
		return nil
	})
	// This is the DAO lookup that an unpublished-blob-specific lease would hit.
	bad := lease
	bad.ID = uuid.NewString()
	bad.ResourceID = upload.BlobID
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), bad)
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("fixture did not exercise the missing resource lookup", err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).ReleaseSessionResourceLease(t.Context(), id, lease.ID)
	})
}

func TestMediaPayloadRewriteAndInventoryPreserveClosedTransactionErrors(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "write", Body: []byte(`{}`)}
	for _, rewrite := range []bool{false, true} {
		if rewrite {
			row.Expected = &store.SessionMediaState{Body: row.Body}
		}
		if err = dao.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatal("save hid closed transaction cause", rewrite, err)
		}
	}
	if rows, err := dao.(store.SessionUploadMediaDAO).SessionUploadMediaRequests(t.Context(), id, uuid.NewString(), uuid.NewString()); !errors.Is(err, pgx.ErrTxClosed) || rows != nil {
		t.Fatal("failed inventory supplied results or hid its cause", rows, err)
	}
}
