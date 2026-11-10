package session_test

import (
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

func TestResourceLedgerReadsPresenceAndRetainsImmutableWriteConflicts(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	ctx := t.Context()
	resource := uuid.NewString()
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: resource, Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Name: "original.png", MediaType: "image/png", ByteLength: "8", SHA256: archiveHashOf("original")}, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{State: "receiving", AcceptedOffset: "0"}}
	ref := store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: "original-message"}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	media := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "read", Fence: fence, Body: []byte(`{}`), Complete: true, Error: &sp.ImageError{Code: "source_unavailable", Message: "Original source unavailable."}}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		found, e := d.SessionResourceReferenceExists(ctx, ref)
		if e != nil || found {
			t.Fatal("absent pin returned present", found, e)
		}
		found, e = d.SessionImageUploadExists(ctx, id, upload.Spec.ImageID)
		if e != nil || found {
			t.Fatal("absent image returned present", found, e)
		}
		if e = d.SaveSessionUpload(ctx, upload); e != nil {
			return e
		}
		if e = d.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "pending", Name: "original.png"}}); e != nil {
			return e
		}
		if e = d.AddSessionResourceReference(ctx, ref); e != nil {
			return e
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(ctx, media)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		found, e := d.SessionResourceReferenceExists(ctx, ref)
		if e != nil || !found {
			t.Fatal("committed pin missing", found, e)
		}
		found, e = d.SessionImageUploadExists(ctx, id, upload.Spec.ImageID)
		if e != nil || !found {
			t.Fatal("committed image missing", found, e)
		}
		changed := upload
		changed.Spec.Name = "replacement.png"
		if e = d.SaveSessionUpload(ctx, changed); e == nil {
			t.Fatal("immutable upload accepted changed original")
		} else {
			var fault *model.Fault
			if !errors.As(e, &fault) || fault.Code != "resource_conflict" {
				return e
			}
		}
		changedMedia := media
		changedMedia.Action = "release"
		if e = base.(store.SessionMediaDAO).SaveSessionMediaRequest(ctx, changedMedia); e == nil {
			t.Fatal("immutable media accepted changed action")
		} else {
			var fault *model.Fault
			if !errors.As(e, &fault) || fault.Code != "resource_conflict" {
				return e
			}
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		u, e := base.(store.SessionResourceDAO).SessionUpload(ctx, id, upload.Spec.UploadID)
		if e != nil {
			return e
		}
		if u.Spec != upload.Spec {
			t.Fatal("rejected replacement changed committed original", u)
		}
		m, e := base.(store.SessionMediaDAO).SessionMediaRequest(ctx, id, media.RequestID)
		if e != nil {
			return e
		}
		if m.Action != media.Action || !m.Complete || m.Error == nil || *m.Error != *media.Error {
			t.Fatal("terminal remote failure did not survive committed readback", m)
		}
		return nil
	})
}

func TestResourceDAOClosedTransactionsPreserveErrorsWithoutSuccessfulResults(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	tx, e := db.Pool.Begin(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(t.Context()); e != nil {
		t.Fatal(e)
	}
	base := pgsession.New(tx)
	resources := base.(store.SessionResourceDAO)
	media := base.(store.SessionMediaDAO)
	checks := []struct {
		name string
		read func() error
	}{
		{"resources", func() error {
			rows, e := resources.ListSessionResources(t.Context(), id)
			if len(rows) != 0 {
				t.Fatal("closed transaction supplied inventory")
			}
			return e
		}},
		{"pending media", func() error {
			rows, e := media.PendingSessionMediaRequests(t.Context(), sp.Fence{SessionID: id})
			if len(rows) != 0 {
				t.Fatal("closed transaction supplied pending media")
			}
			return e
		}},
		{"usage", func() error { _, e := resources.SessionResourceUsage(t.Context(), id); return e }},
		{"upload save", func() error {
			return resources.SaveSessionUpload(t.Context(), store.SessionUploadRecord{SessionID: id})
		}},
		{"media save", func() error {
			return media.SaveSessionMediaRequest(t.Context(), store.SessionMediaRequest{SessionID: id})
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if e := check.read(); !errors.Is(e, pgx.ErrTxClosed) {
				t.Fatal("closed transaction result lost its cause", e)
			}
		})
	}
}

func TestMediaRequestReadRejectsCorruptPersistedTypedMetadata(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	ctx := t.Context()
	request := uuid.NewString()
	for _, kind := range []string{"fence", "error"} {
		t.Run(kind, func(t *testing.T) {
			fence, errorBody := `{"sessionId":"`+id+`","claimId":"`+uuid.NewString()+`","executionGeneration":"1","connectionEpoch":"1"}`, `{"code":"source_unavailable","message":"Original source unavailable."}`
			if kind == "fence" {
				fence = `{"connectionEpoch":2}`
			} else {
				errorBody = `{"code":3}`
			}
			if _, e := db.Pool.Exec(ctx, `INSERT INTO session_media_requests(session_id,request_id,action,fence,body,error,complete) VALUES($1,$2,'read',$3,'{}',$4,true) ON CONFLICT(session_id,request_id) DO UPDATE SET fence=EXCLUDED.fence,error=EXCLUDED.error`, id, request, fence, errorBody); e != nil {
				t.Fatal(e)
			}
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				if _, e := base.(store.SessionMediaDAO).SessionMediaRequest(ctx, id, request); e == nil {
					t.Fatal("corrupt persisted typed metadata became valid")
				}
				return nil
			})
		})
	}
}

func TestResourceCancelledObservationDoesNotCreateState(t *testing.T) {
	db, _, _ := imageLedgerSession(t)
	missing := uuid.NewString()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	tx, e := db.Pool.Begin(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if _, e = pgsession.New(tx).(store.SessionResourceDAO).SessionResourceUsage(ctx, missing); !errors.Is(e, context.Canceled) {
		t.Fatal("cancelled admission was reported successful", e)
	}
	var count int
	if e = db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM session_resource_state WHERE session_id=$1`, missing).Scan(&count); e != nil || count != 0 {
		t.Fatal("cancelled observation allocated resource state", count, e)
	}
}
