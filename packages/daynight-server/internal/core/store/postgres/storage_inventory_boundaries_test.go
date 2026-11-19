package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestBackupInventoryIncludesReadyIdentityAndBothOriginalRepresentations(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); e != nil {
		t.Fatal(e)
	}
	hash, length, mime := strings.Repeat("a", 64), "1", "text/plain"
	blob := uuid.NewString()
	inlineID, blobID := uuid.NewString(), uuid.NewString()
	for _, resourceID := range []string{inlineID, blobID} {
		descriptor, e := json.Marshal(sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime})
		if e != nil {
			t.Fatal(e)
		}
		if resourceID == inlineID {
			_, e = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,$3,$4)`, id, resourceID, descriptor, []byte("x"))
		} else {
			_, e = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$4,'original/blob')`, id, resourceID, descriptor, blob)
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness) VALUES($1,'ready',$2,1,'original/manifest',3,'complete')`, id, hash); e != nil {
		t.Fatal(e)
	}
	calls := 0
	e := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		calls++
		if v.SessionID != id || v.OwnerID != owner || v.Archive == nil || v.Archive.SchemaVersion != 3 || v.Archive.Path != "original/manifest" || v.Archive.SHA256 != hash || v.Archive.ByteLength != 1 || len(v.Resources) != 2 || len(v.InlineResources) != 1 || v.InlineResources[0].Resource.ResourceID != inlineID || string(v.InlineResources[0].Content) != "x" {
			t.Fatal("restored inventory lost original bytes or ready identity", v)
		}
		found := false
		for _, r := range v.Resources {
			if r.Resource.ResourceID == blobID && r.BlobID == blob && r.BlobPath == "original/blob" {
				found = true
			}
		}
		if !found {
			t.Fatal("stored immutable blob identity omitted")
		}
		return nil
	})
	if e != nil || calls != 1 {
		t.Fatal(calls, e)
	}
}

type backupInventoryFixture struct {
	database  *Store
	id, owner string
}

func newBackupInventoryFixture(t *testing.T) backupInventoryFixture {
	t.Helper()
	f := backupInventoryFixture{database: isolatedStore(t), id: uuid.NewString(), owner: uuid.NewString()}
	mustQueryExec(t, f.database, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, f.id, f.owner, uuid.NewString())
	return f
}

func (f backupInventoryFixture) requireCleanInventory(t *testing.T, ctx context.Context) {
	t.Helper()
	calls := 0
	err := f.database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		calls++
		if v.SessionID != f.id || v.OwnerID != f.owner || v.ProjectID != "" || v.Archive != nil || v.Migration != nil ||
			len(v.Resources)+len(v.InlineResources)+len(v.Objects) != 0 {
			return fmt.Errorf("restored inventory differs: %+v", v)
		}
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("inventory fixture after restoration: callbacks=%d error=%v", calls, err)
	}
}

func (f backupInventoryFixture) hideRelation(t *testing.T, ctx context.Context, relation string) func(context.Context) {
	t.Helper()
	hidden := "missing_" + relation
	relationOIDs := func(ctx context.Context) (uint32, uint32) {
		var original, renamed uint32
		if err := f.database.Pool.QueryRow(ctx, `SELECT COALESCE(to_regclass($1)::oid,0::oid),COALESCE(to_regclass($2)::oid,0::oid)`, relation, hidden).Scan(&original, &renamed); err != nil {
			t.Fatal(err)
		}
		return original, renamed
	}
	original, renamed := relationOIDs(ctx)
	if original == 0 || renamed != 0 {
		t.Fatalf("unexpected catalog before hiding %s: original=%d renamed=%d", relation, original, renamed)
	}
	sourceName, hiddenName := pgx.Identifier{relation}.Sanitize(), pgx.Identifier{hidden}.Sanitize()
	if _, err := f.database.Pool.Exec(ctx, "ALTER TABLE "+sourceName+" RENAME TO "+hiddenName); err != nil {
		t.Fatal(err)
	}
	if source, target := relationOIDs(ctx); source != 0 || target != original {
		t.Fatalf("unexpected catalog after hiding %s: original=%d renamed=%d, want (0,%d)", relation, source, target, original)
	}
	f.database.Pool.Reset()
	return func(ctx context.Context) {
		if _, err := f.database.Pool.Exec(ctx, "ALTER TABLE "+hiddenName+" RENAME TO "+sourceName); err != nil {
			t.Fatal(err)
		}
		if source, target := relationOIDs(ctx); source != original || target != 0 {
			t.Fatalf("unexpected catalog after restoring %s: original=%d renamed=%d, want (%d,0)", relation, source, target, original)
		}
		f.database.Pool.Reset()
	}
}

func TestBackupInventoryRejectsCorruptRestoredMetadataAndMissingRelations(t *testing.T) {
	parallelRootDatabaseTest(t)
	shared := newBackupInventoryFixture(t)
	for _, test := range []struct{ kind, relation string }{
		{kind: "descriptor"},
		{kind: "ready-identity"},
		{kind: "missing-resources", relation: "session_resources"},
		{kind: "missing-chunks", relation: "session_image_chunks"},
		{kind: "missing-archives", relation: "session_archives"},
		{kind: "canceled"},
	} {
		if !t.Run(test.kind, func(t *testing.T) {
			ctx, stop := context.WithTimeout(t.Context(), 15*time.Second)
			defer stop()
			f := shared
			var restore func(context.Context)
			if test.kind == "ready-identity" {
				f = newBackupInventoryFixture(t)
			} else {
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if restore != nil {
						restore(ctx)
					}
					f.requireCleanInventory(t, ctx)
				})
			}
			switch test.kind {
			case "descriptor":
				resource := uuid.NewString()
				mustQueryExec(t, f.database, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, f.id, resource)
				restore = func(ctx context.Context) {
					tag, err := f.database.Pool.Exec(ctx, `DELETE FROM session_resources WHERE session_id=$1 AND resource_id=$2`, f.id, resource)
					if err != nil || tag.RowsAffected() != 1 {
						t.Fatalf("remove corrupt descriptor: %v, %v", tag, err)
					}
				}
			case "ready-identity":
				mustQueryExec(t, f.database, `ALTER TABLE session_archives DROP CONSTRAINT session_archive_body`)
				mustQueryExec(t, f.database, `INSERT INTO session_archives(session_id,state) VALUES($1,'ready')`, f.id)
			case "canceled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			default:
				restore = f.hideRelation(t, ctx, test.relation)
			}
			calls := 0
			err := f.database.VerifyStorageInventory(ctx, func(store.StorageInventory) error { calls++; return nil })
			if err == nil || calls != 0 {
				t.Fatalf("invalid restored cut reached the closure verifier: callbacks=%d error=%v", calls, err)
			}
			switch test.kind {
			case "descriptor":
				_, want := sp.DecodeResource([]byte("{}"))
				if !errors.Is(err, want) {
					t.Fatalf("descriptor decode cause replaced: %v", err)
				}
			case "ready-identity":
				if err.Error() != "ready archive has incomplete storage identity" {
					t.Fatalf("missing archive identity cause replaced: %v", err)
				}
			case "canceled":
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("inventory cancellation cause replaced: %v", err)
				}
			default:
				var pg *pgconn.PgError
				if !errors.As(err, &pg) || pg.Code != "42P01" {
					t.Fatalf("inventory did not report missing %s: %v", test.relation, err)
				}
			}
		}) {
			return
		}
	}
}
