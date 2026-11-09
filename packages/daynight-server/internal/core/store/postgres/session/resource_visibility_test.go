package session_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestSavedResourceVisibilityRequiresActorOrPublishedReference(t *testing.T) {
	db, _, session := sessionArchiveLockFixture(t)
	actor, other, resource, upload, prepare, migration := "", uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if err := db.Pool.QueryRow(t.Context(), `SELECT owner_user_id::text FROM task_sessions WHERE id=$1`, session).Scan(&actor); err != nil {
		t.Fatal(err)
	}
	with := func(work func(store.SessionResourceDAO) error) {
		t.Helper()
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			if _, err := d.LockSession(t.Context(), session); err != nil {
				return err
			}
			return work(d.(store.SessionResourceDAO))
		})
	}
	assertVisible := func(who string, want bool) {
		t.Helper()
		with(func(d store.SessionResourceDAO) error {
			got, err := d.SessionResourceReadableBy(t.Context(), session, resource, who)
			if err != nil || got != want {
				t.Fatalf("visibility actor=%s got=%v want=%v: %v", who, got, want, err)
			}
			return nil
		})
	}
	add := func(kind, identity string) {
		t.Helper()
		with(func(d store.SessionResourceDAO) error {
			return d.AddSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: session, ResourceID: resource, Kind: kind, ReferenceID: identity})
		})
	}
	remove := func(kind, identity string) {
		t.Helper()
		with(func(d store.SessionResourceDAO) error {
			return d.RemoveSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: session, ResourceID: resource, Kind: kind, ReferenceID: identity})
		})
	}
	image := sp.Resource{ResourceID: resource, Revision: "1", Status: "available"}
	with(func(d store.SessionResourceDAO) error {
		return d.InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: session, Resource: image})
	})
	assertVisible(actor, false)
	u := store.SessionUploadRecord{SessionID: session, ActorID: actor, BlobID: resource, ExpiresAt: time.Now().Add(time.Hour), Spec: sp.ImageUploadSpec{UploadID: upload, ImageID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: "3"}, Receipt: sp.ImageUploadReceipt{State: "complete", Resource: &image}}
	with(func(d store.SessionResourceDAO) error { return d.SaveSessionUpload(t.Context(), u) })
	add("upload", upload)
	assertVisible(actor, true)
	assertVisible(other, false)
	u.Receipt.State = "verifying"
	with(func(d store.SessionResourceDAO) error { return d.SaveSessionUpload(t.Context(), u) })
	assertVisible(actor, false)
	u.Receipt.State, u.Receipt.Resource = "complete", &sp.Resource{ResourceID: uuid.NewString()}
	with(func(d store.SessionResourceDAO) error { return d.SaveSessionUpload(t.Context(), u) })
	assertVisible(actor, false)
	for _, kind := range []string{"operation", "unknown", "native_resume"} {
		add(kind, "original")
		assertVisible(other, false)
		remove(kind, "original")
	}
	add("message", "entry-image")
	assertVisible(other, true)
	remove("message", "entry-image")
	assertVisible(other, false)
	add("archive", prepare)
	mustQueryExec(t, db, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,manifest_hash) VALUES($1,$2,'sealed',1,'{}',$3)`, session, prepare, strings.Repeat("b", 64))
	assertVisible(other, false)
	mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness) VALUES($1,'ready',$2,100,'manifest',3,'complete')`, session, strings.Repeat("b", 64))
	assertVisible(other, false)
	mustQueryExec(t, db, `UPDATE session_archive_bundles SET phase='committed' WHERE session_id=$1`, session)
	assertVisible(other, true)
	mustQueryExec(t, db, `UPDATE session_archive_bundles SET manifest_hash=$2 WHERE session_id=$1`, session, strings.Repeat("c", 64))
	assertVisible(other, false)
	add("archive", migration)
	mustQueryExec(t, db, `INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,target_path,target_hash,phase) VALUES($1,$2,'legacy',$3,100,'manifest',$4,'files_durable')`, session, migration, strings.Repeat("a", 64), strings.Repeat("b", 64))
	assertVisible(other, false)
	mustQueryExec(t, db, `UPDATE session_archive_migrations SET phase='verified' WHERE session_id=$1`, session)
	assertVisible(other, true)
	mustQueryExec(t, db, `UPDATE session_archive_migrations SET target_hash=$2 WHERE session_id=$1`, session, strings.Repeat("c", 64))
	assertVisible(other, false)
	with(func(d store.SessionResourceDAO) error {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := d.SessionResourceReadableBy(ctx, session, resource, actor); !errors.Is(err, context.Canceled) {
			t.Fatal("visibility query lost cancellation", err)
		}
		return nil
	})
}
