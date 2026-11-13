package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testUploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory(t *testing.T, db *postgres.Store, field string) {
	id, actor := prepareImageSession(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	ids := []string{uuid.NewString(), uuid.NewString()}
	sort.Strings(ids)
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		for _, uploadID := range ids {
			upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: uploadID, ImageID: uuid.NewString(), ByteLength: "8", SHA256: archiveHashOf("original")}, ExpiresAt: now, Receipt: sp.ImageUploadReceipt{State: "receiving", AcceptedOffset: "0"}}
			if err := base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
				return err
			}
		}
		return nil
	})
	// These values are valid JSONB but cannot be decoded into the stored
	// model. Keep the second row selected after a valid first result.
	if field == "spec" {
		mustQueryExec(t, db, `UPDATE session_image_uploads SET spec='[]'::jsonb WHERE session_id=$1 AND upload_id=$2`, id, ids[1])
	} else {
		mustQueryExec(t, db, `UPDATE session_image_uploads SET receipt='{"state":"receiving","acceptedOffset":17}'::jsonb WHERE session_id=$1 AND upload_id=$2`, id, ids[1])
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		rows, err := base.(store.SessionResourceSettlementDAO).ListSessionUploadsForSettlement(t.Context(), id, now)
		var invalid *json.UnmarshalTypeError
		if !errors.As(err, &invalid) || rows != nil {
			t.Fatal("corrupt persisted upload became a partial successful inventory", rows, err)
		}
		// Decoding failure must remain observable without deleting or
		// repairing the original persistence record.
		_, err = base.(store.SessionResourceDAO).SessionUpload(t.Context(), id, ids[1])
		if !errors.As(err, &invalid) {
			t.Fatal("inventory silently repaired corrupt persisted JSON", err)
		}
		return nil
	})
}

func testUploadSettlementPreservesClosedTransactionAndCancellationErrors(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	for _, kind := range []string{"closed transaction", "cancelled context"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer rollbackSessionTestTransaction(t, tx)
			want := error(context.Canceled)
			if kind == "closed transaction" {
				if err = tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				want = pgx.ErrTxClosed
			} else {
				cancel()
			}
			dao := pgsession.New(tx).(store.SessionResourceSettlementDAO)
			rows, err := dao.ListSessionUploadsForSettlement(ctx, id, time.Now())
			if !errors.Is(err, want) || rows != nil {
				t.Fatal("failed settlement query supplied a successful inventory or hid its cause", rows, err)
			}
		})
	}
}

func testResourceReclamationPersistsAdmissionBarrierUntilFinalDeletion(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	ctx := t.Context()
	resource := uuid.NewString()
	size := "8"
	original := sp.Resource{ResourceID: resource, Revision: "1", Status: "available", Name: "original.png", ByteLength: &size}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: resource, Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), ByteLength: size, SHA256: archiveHashOf("original")}, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond), Receipt: sp.ImageUploadReceipt{State: "released"}, StorageReleased: true}
	ref := store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: "published"}
	lease := store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), ResourceID: resource, OwnerID: actor.UserID, Kind: "read"}
	with := func(work func(store.SessionDAO, store.SessionResourceDAO, store.SessionResourceSettlementDAO) error) {
		t.Helper()
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			if _, e := base.LockSession(ctx, id); e != nil {
				return e
			}
			return work(base, base.(store.SessionResourceDAO), base.(store.SessionResourceSettlementDAO))
		})
	}
	with(func(_ store.SessionDAO, d store.SessionResourceDAO, _ store.SessionResourceSettlementDAO) error {
		if e := d.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: original, BlobID: resource, BlobPath: "original/blob"}); e != nil {
			return e
		}
		if e := d.SaveSessionUpload(ctx, upload); e != nil {
			return e
		}
		return d.AddSessionResourceReference(ctx, ref)
	})
	with(func(_ store.SessionDAO, d store.SessionResourceDAO, gc store.SessionResourceSettlementDAO) error {
		claimed, e := gc.MarkSessionResourceReclaim(ctx, id, resource)
		if e != nil || claimed {
			t.Fatal("published original was claimed", claimed, e)
		}
		// A released upload must not prevent legitimate message/archive pin
		// handoff while another durable owner still retains the original.
		archive := ref
		archive.Kind, archive.ReferenceID = "archive", uuid.NewString()
		if e = d.AddSessionResourceReference(ctx, archive); e != nil {
			return e
		}
		if e = d.RemoveSessionResourceReference(ctx, ref); e != nil {
			return e
		}
		if e = d.RemoveSessionResourceReference(ctx, archive); e != nil {
			return e
		}
		return d.AcquireSessionResourceLease(ctx, lease)
	})
	with(func(_ store.SessionDAO, _ store.SessionResourceDAO, gc store.SessionResourceSettlementDAO) error {
		claimed, e := gc.MarkSessionResourceReclaim(ctx, id, resource)
		if e != nil || !claimed {
			t.Fatal("unreferenced original was not durably claimed", claimed, e)
		}
		return nil
	})
	with(func(_ store.SessionDAO, d store.SessionResourceDAO, gc store.SessionResourceSettlementDAO) error {
		saved, e := d.SavedSessionResource(ctx, id, resource)
		if e != nil || !saved.GCPending || saved.BlobID != resource || saved.BlobPath != "original/blob" {
			t.Fatal("reclamation changed or lost original identity", saved, e)
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil || usage.Bytes != 8 || usage.Resources != 1 {
			t.Fatal("claim returned quota before physical cleanup", usage, e)
		}
		if e = d.AddSessionResourceReference(ctx, ref); e == nil {
			t.Fatal("GC original was resurrected by a new pin")
		}
		newLease := lease
		newLease.ID = uuid.NewString()
		if e = d.AcquireSessionResourceLease(ctx, newLease); e == nil {
			t.Fatal("GC original admitted a new reader")
		}
		newLease.ResourceID, newLease.Kind = "", "write"
		if e = d.AcquireSessionResourceLease(ctx, newLease); e == nil {
			t.Fatal("GC original admitted a new session-wide writer")
		}
		if e = gc.DeleteReclaimedSessionResource(ctx, id, resource); e == nil {
			t.Fatal("active reader lost its original row")
		}
		pending, e := gc.ListSessionUploadsForSettlement(ctx, id, time.Now())
		if e != nil || len(pending) != 1 || pending[0].Spec.UploadID != upload.Spec.UploadID {
			t.Fatal("cleaned staging hid pending original reclamation", pending, e)
		}
		n, e := d.UnsettledSessionResourceWrites(ctx, id)
		if e != nil || n == 0 {
			t.Fatal("archive closure ignored pending original reclamation", n, e)
		}
		return nil
	})
	// An interrupted final transaction cannot return quota; the next owner
	// reuses the same persisted GC identity and lease after rollback.
	tx, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer rollbackSessionTestTransaction(t, tx)
	d := pgsession.New(tx)
	if _, e = d.LockSession(ctx, id); e != nil {
		t.Fatal(e)
	}
	if e = d.(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, id, lease.ID); e != nil {
		t.Fatal(e)
	}
	if e = d.(store.SessionResourceSettlementDAO).DeleteReclaimedSessionResource(ctx, id, resource); e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	with(func(_ store.SessionDAO, d store.SessionResourceDAO, gc store.SessionResourceSettlementDAO) error {
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil || usage.Bytes != 8 {
			t.Fatal("rolled back cleanup lost quota reservation", usage, e)
		}
		if e = d.ReleaseSessionResourceLease(ctx, id, lease.ID); e != nil {
			return e
		}
		return gc.DeleteReclaimedSessionResource(ctx, id, resource)
	})
	with(func(_ store.SessionDAO, d store.SessionResourceDAO, gc store.SessionResourceSettlementDAO) error {
		if _, e := d.SavedSessionResource(ctx, id, resource); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("final cleanup retained original row", e)
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil || usage.Bytes != 0 || usage.Resources != 0 {
			t.Fatal("cleanup quota or immutable tombstone changed", usage, e)
		}
		saved, e := d.SessionUpload(ctx, id, upload.Spec.UploadID)
		if e != nil || saved.Spec != upload.Spec || saved.BlobID != resource {
			t.Fatal("original upload tombstone was lost", saved, e)
		}
		claimed, e := gc.MarkSessionResourceReclaim(ctx, id, resource)
		if e != nil || !claimed {
			t.Fatal("completed cleanup is not reentrant", claimed, e)
		}
		return gc.DeleteReclaimedSessionResource(ctx, id, resource)
	})
}

func testUploadSettlementSelectsFixedExpiryAndUnconfirmedCleanup(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	want := map[string]bool{}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		for _, c := range []struct {
			state                   string
			due, released, selected bool
		}{{"receiving", true, false, true}, {"verifying", true, false, true}, {"receiving", false, false, false}, {"complete", true, false, true}, {"expired", true, false, true}, {"released", true, false, true}, {"failed", true, false, true}, {"expired", true, true, false}} {
			expiry := now
			if !c.due {
				expiry = now.Add(time.Microsecond)
			}
			u := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), ByteLength: "8", SHA256: archiveHashOf("original")}, ExpiresAt: expiry, Receipt: sp.ImageUploadReceipt{State: c.state}, StorageReleased: c.released}
			if c.selected {
				want[u.Spec.UploadID] = true
			}
			if e := d.SaveSessionUpload(t.Context(), u); e != nil {
				return e
			}
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		rows, e := base.(store.SessionResourceSettlementDAO).ListSessionUploadsForSettlement(t.Context(), id, now)
		if e != nil || len(rows) != len(want) {
			t.Fatal("settlement inventory changed expiry or cleanup boundary", rows, e)
		}
		for _, row := range rows {
			if !want[row.Spec.UploadID] {
				t.Fatal("settlement selected an active or already cleaned upload", row)
			}
		}
		return nil
	})
}

func TestResourceReclamationWaitsForSessionPinTransaction(t *testing.T) {
	db := isolatedStore(t)
	id, _ := prepareImageSession(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	resource := uuid.NewString()
	first, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Rollback(context.Background())
	pin := pgsession.New(first)
	if _, e = pin.LockSession(ctx, id); e != nil {
		t.Fatal(e)
	}
	r := pin.(store.SessionResourceDAO)
	if e = r.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Revision: "1", Status: "pending", Name: "original"}}); e != nil {
		t.Fatal(e)
	}
	if e = r.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: "original"}); e != nil {
		t.Fatal(e)
	}
	second, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Rollback(context.Background())
	done := make(chan struct{})
	var claimed bool
	var result error
	go func() {
		defer close(done)
		gc := pgsession.New(second)
		if _, result = gc.LockSession(ctx, id); result == nil {
			claimed, result = gc.(store.SessionResourceSettlementDAO).MarkSessionResourceReclaim(ctx, id, resource)
		}
	}()
	blocked := awaitSessionStoreBlock(ctx, db, first.Conn().PgConn().PID(), second.Conn().PgConn().PID(), done)
	commit := first.Commit(ctx)
	<-done
	if blocked != nil || commit != nil || result != nil || claimed {
		t.Fatal("reclamation missed the serialized durable pin", blocked, commit, result, claimed)
	}
}
