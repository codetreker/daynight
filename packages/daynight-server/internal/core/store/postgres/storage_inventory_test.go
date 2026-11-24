package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestBackupInventoryExpiredArchiveRetainsIndependentResources(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	id, owner, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := database.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$4,$1,'{}','{}')`, id, project, task, owner)
	digest := strings.Repeat("a", 64)
	exec(`INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',$2,7,'retired-manifest')`, id, digest)
	file := uuid.NewString()
	exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path) VALUES($1,$2,'timeline',$3,7,7,'complete','retired-timeline')`, id, file, digest)
	exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,7,$3,'retired-chunk')`, id, file, digest)
	exec(`INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,phase) VALUES($1,$2,'retired-source',$3,7,'files_durable')`, id, uuid.NewString(), digest)
	data := []byte("retained original")
	hash := sha256.Sum256(data)
	resourceHash, length, mediaType := hex.EncodeToString(hash[:]), "17", "text/plain"
	var sharedID, sharedPath string
	for _, shared := range []bool{false, true} {
		resource := uuid.NewString()
		path, err := sessioncore.BlobAddress(project, owner, id, resource)
		if err != nil {
			t.Fatal(err)
		}
		descriptor, err := json.Marshal(sp.Resource{ResourceID: resource, Name: "original", Status: "available", MediaType: &mediaType, ByteLength: &length, SHA256: &resourceHash})
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path,gc_pending) VALUES($1,$2,$3,$2,$4,true)`, id, resource, descriptor, path)
		if _, err := files.Put(ctx, sessionresource.Bucket, path, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		if shared {
			sharedID, sharedPath = resource, path
			exec(`INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$2,'native_resume','independent-owner')`, id, resource)
		} else if err := files.Delete(ctx, sessionresource.Bucket, path); err != nil {
			t.Fatal(err)
		}
	}
	// GC state by itself does not weaken verification of a readable archive.
	if err := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		if v.Archive == nil || v.Migration == nil || len(v.Resources) != 2 || len(v.Objects) != 2 {
			t.Fatalf("live storage closure omitted: %+v", v)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO session_archive_retention(session_id,expired_at,reason) VALUES($1,now(),'expired')`, id)
	verify := func() error {
		return database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
			if v.Archive != nil || v.Migration != nil || len(v.Objects) != 0 || len(v.Resources) != 1 || v.Resources[0].Resource.ResourceID != sharedID {
				t.Fatalf("expired storage closure: %+v", v)
			}
			return sessioncore.VerifyStorageBackup(ctx, files, v)
		})
	}
	// Physical bytes are already gone but the durable cleanup receipt is pending.
	if err := verify(); err != nil {
		t.Fatalf("pending cleanup backup: %v", err)
	}
	exec(`UPDATE session_archive_retention SET cleaned_at=now() WHERE session_id=$1`, id)
	if err := verify(); err != nil {
		t.Fatalf("completed cleanup backup: %v", err)
	}
	if err := files.Delete(ctx, sessionresource.Bucket, sharedPath); err != nil {
		t.Fatal(err)
	}
	if err := verify(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing independent original ignored: %v", err)
	}
	if _, err := files.Put(ctx, sessionresource.Bucket, sharedPath, bytes.NewReader([]byte("corrupt"))); err != nil {
		t.Fatal(err)
	}
	if err := verify(); err == nil {
		t.Fatal("corrupt independent original ignored")
	}
}

func TestBackupReaderRequiresCurrentMigrationChainAndRemainsReadOnly(t *testing.T) {
	url := scopedDatabaseURL(t)
	database, err := Open(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	readonly, err := OpenReadOnly(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	if err = readonly.Pool.QueryRow(t.Context(), "SHOW default_transaction_read_only").Scan(&mode); err != nil || mode != "on" {
		t.Fatal(mode, err)
	}
	if _, err = readonly.Pool.Exec(t.Context(), "CREATE TABLE forbidden_backup_mutation(id int)"); err == nil {
		t.Fatal("reader allowed DDL")
	}
	readonly.Close()
	_, err = database.Pool.Exec(t.Context(), "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version=(SELECT max(version) FROM schema_migrations)")
	if err != nil {
		t.Fatal(err)
	}
	if value, err := OpenReadOnly(t.Context(), url); err == nil {
		value.Close()
		t.Fatal("reader accepted changed migration checksum")
	}
	var count int
	if err = database.Pool.QueryRow(t.Context(), "SELECT count(*) FROM information_schema.tables WHERE table_name='forbidden_backup_mutation'").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}

func TestBackupInventoryRejectsOrphansAndRetainsCallbackFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("integrity failed")
	calls := 0
	err := database.VerifyStorageInventory(ctx, func(value store.StorageInventory) error {
		calls++
		if value.SessionID != id || value.OwnerID != owner || value.ProjectID != "" {
			t.Fatal(value)
		}
		return sentinel
	})
	if calls != 1 || !errors.Is(err, sentinel) {
		t.Fatal(calls, err)
	}
	if _, err = database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	calls = 0
	err = database.VerifyStorageInventory(ctx, func(store.StorageInventory) error { calls++; return nil })
	if err == nil || calls != 0 {
		t.Fatal("orphan archive omitted", calls, err)
	}
}

func TestBackupReaderFailuresRedactConnectionDetails(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, url := range []string{"postgres://secret-user:secret-password@bad%host/db", "postgres://secret-user:secret-password@127.0.0.1:1/db?connect_timeout=1"} {
		_, err := OpenReadOnly(context.Background(), url)
		if err == nil || strings.Contains(err.Error(), "secret-") {
			t.Fatal("unsafe reader diagnostic", err)
		}
	}
}

func TestBackupInventoryRetainsMigrationAndSkipsReleasedStagingTombstones(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); e != nil {
		t.Fatal(e)
	}
	digest := strings.Repeat("a", 64)
	for _, released := range []bool{false, true} {
		upload, file := uuid.NewString(), uuid.NewString()
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at,storage_released) VALUES($1,$2,$3,$4,$5,'{}','{"state":"complete"}',now(),$6)`, id, upload, owner, uuid.NewString(), uuid.NewString(), released); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$2,0,1,$3,'image-staging')`, id, upload, digest); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,staging_released) VALUES($1,$2,'history',$3,1,1,'complete','history-staging',$4)`, id, file, digest, released); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,1,$3,'archive-staging')`, id, file, digest); e != nil {
			t.Fatal(e)
		}
	}
	migration := store.ArchiveMigration{SessionID: id, MigrationID: uuid.NewString(), SourcePath: "source", SourceHash: digest, SourceLength: 1, TargetPath: "target", TargetHash: digest, Phase: "files_durable"}
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,target_path,target_hash,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, migration.MigrationID, migration.SourcePath, migration.SourceHash, migration.SourceLength, migration.TargetPath, migration.TargetHash, migration.Phase); e != nil {
		t.Fatal(e)
	}
	calls := 0
	e := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		calls++
		if v.Migration == nil || *v.Migration != migration || len(v.Objects) != 2 {
			t.Fatal("durable source or unreleased stage omitted", v)
		}
		return nil
	})
	if e != nil || calls != 1 {
		t.Fatal(calls, e)
	}
}

func TestBackupInventoryDistinguishesUnconfirmedFirstChunk(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	for _, tc := range []struct {
		name     string
		offset   int64
		optional bool
	}{
		{"receiving", 0, true}, {"failed", 0, true}, {"failed newline", 0, true}, {"failed tab", 0, true}, {"expired", 0, true}, {"released", 0, true},
		{"confirmed", 0, false}, {"partially confirmed", 0, false}, {"nonfirst", 1, false},
		{"verifying zero", 0, false}, {"complete zero", 0, false}, {"missing offset", 0, false},
		{"numeric offset", 0, false}, {"noncanonical offset", 0, false}, {"missing state", 0, false},
		{"bad hash", 0, false}, {"bad path", 0, false}, {"bad length", 0, false}, {"bad spec", 0, false}, {"bad receipt", 0, false}, {"wrong actor", 0, false}, {"invalid failure", 0, false},
	} {
		if !t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			owner, id, execution, upload := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); err != nil {
				t.Fatal(err)
			}
			image := uuid.NewString()
			actor := owner
			if tc.name == "wrong actor" {
				actor = uuid.NewString()
			}
			expiry := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
			spec := sp.ImageUploadSpec{UploadID: upload, ImageID: image, Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor, Fence: sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}}, Name: "original.png", MediaType: "image/png", ByteLength: "2", SHA256: strings.Repeat("a", 64)}
			receipt := sp.ImageUploadReceipt{UploadID: upload, ImageID: image, Target: spec.Target, State: "receiving", AcceptedOffset: "0", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}, ExpiresAt: expiry.Format(time.RFC3339Nano)}
			switch tc.name {
			case "failed", "expired":
				receipt.State, receipt.Error = tc.name, &sp.ImageError{Code: "storage_unavailable", Message: "Storage unavailable."}
			case "failed newline":
				receipt.State, receipt.Error = "failed", &sp.ImageError{Code: "storage_unavailable", Message: "Storage\nunavailable."}
			case "failed tab":
				receipt.State, receipt.Error = "failed", &sp.ImageError{Code: "storage_unavailable", Message: "Storage\tunavailable."}
			case "invalid failure":
				receipt.State, receipt.Error = "failed", &sp.ImageError{Code: "storage_unavailable", Message: " "}
			case "released":
				receipt.State = tc.name
			case "confirmed", "partially confirmed":
				receipt.AcceptedOffset = "1"
			case "verifying zero":
				receipt.State = "verifying"
			case "complete zero":
				receipt.State = "complete"
			}
			specRaw, _ := json.Marshal(spec)
			receiptRaw, _ := json.Marshal(receipt)
			var receiptFields map[string]any
			_ = json.Unmarshal(receiptRaw, &receiptFields)
			switch tc.name {
			case "missing offset":
				delete(receiptFields, "acceptedOffset")
			case "numeric offset":
				receiptFields["acceptedOffset"] = 0
			case "noncanonical offset":
				receiptFields["acceptedOffset"] = "00"
			case "missing state":
				delete(receiptFields, "state")
			case "bad receipt":
				receiptFields["uploadId"] = uuid.NewString()
			case "bad spec":
				spec.UploadID = uuid.NewString()
				specRaw, _ = json.Marshal(spec)
			}
			receiptRaw, _ = json.Marshal(receiptFields)
			if _, err := database.Pool.Exec(ctx, `INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, upload, actor, image, uuid.NewString(), specRaw, receiptRaw, expiry); err != nil {
				t.Fatal(err)
			}
			length := 1
			if tc.name == "partially confirmed" {
				length = 2
			}
			if tc.name == "bad length" {
				length = 0
			}
			digest := strings.Repeat("a", 64)
			if tc.name == "bad hash" {
				digest = "not-a-sha256"
			}
			namespace, err := sessionresource.NewNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			path, err := namespace.ChunkPath(upload, tc.offset)
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "bad path" {
				path = "wrong/path"
			}
			if _, err := database.Pool.Exec(ctx, `INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$2,$3,$4,$5,$6)`, id, upload, tc.offset, length, digest, path); err != nil {
				t.Fatal(err)
			}
			calls := 0
			err = database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
				calls++
				if len(v.Objects) != 1 || v.Objects[0].Path != path || v.Objects[0].ByteLength != int64(length) || v.Objects[0].Optional != tc.optional {
					t.Fatal("chunk or its confirmation status changed", v.Objects)
				}
				return nil
			})
			if calls != 1 || err != nil {
				t.Fatal("inventory failed", calls, err)
			}
		}) {
			return
		}
		resetInventoryChunkFixture(t, database)
	}
}

func resetInventoryChunkFixture(t *testing.T, database *Store) {
	t.Helper()
	testutil.AssertPoolReusable(t, database.Pool)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := database.Pool.Exec(ctx, `DELETE FROM session_image_chunks;
DELETE FROM session_image_uploads;
DELETE FROM task_sessions;`); err != nil {
		t.Fatal(err)
	}
	// Inventory joins can hide orphan chunks after the Session or upload is removed.
	var chunks, uploads, sessions int
	if err := database.Pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM session_image_chunks),
 (SELECT count(*) FROM session_image_uploads),
 (SELECT count(*) FROM task_sessions)`).Scan(&chunks, &uploads, &sessions); err != nil {
		t.Fatal(err)
	}
	if chunks != 0 || uploads != 0 || sessions != 0 {
		t.Fatalf("inventory chunk fixture retained rows: chunks=%d uploads=%d sessions=%d", chunks, uploads, sessions)
	}
	testutil.AssertPoolReusable(t, database.Pool)
}

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
				restore = testutil.HideRelation(t, ctx, f.database.Pool, test.relation)
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
