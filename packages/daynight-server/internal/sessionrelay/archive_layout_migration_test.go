package sessionrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type archiveLayoutSeed struct {
	id, digest string
	body       []byte
	namespace  sessionarchive.Namespace
}

func archiveLayoutTestFiles(t *testing.T) (fixture, string) {
	t.Helper()
	f := setup(t)
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	f.s.files = files
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return f, root
}

func seedArchiveLayout(t *testing.T, f fixture, scope string, version int, ready bool) archiveLayoutSeed {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	claim, execution := uuid.NewString(), uuid.NewString()
	var project, task, claimID, testID *string
	kind, owner := sessionarchive.Projects, f.project
	backend := "web"
	if scope == "task" {
		project, task, claimID = &f.project, &f.task, &claim
	} else {
		testID, kind, owner = &execution, sessionarchive.Users, f.p.UserID
	}
	namespace, err := sessionarchive.NewNamespace(kind, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	var body []byte
	var completeness, finalization *string
	var receipt []byte
	if version == 1 {
		fence := sp.Fence{SessionID: id, ExecutionGeneration: "1"}
		if scope == "task" {
			fence.ClaimID = claim
		} else {
			fence.TestExecutionID = execution
		}
		body = encode(sp.ArchiveDocument{Fence: fence, SchemaVersion: 1, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
		if _, err := sp.DecodeArchive(body); err != nil {
			t.Fatal("invalid Web migration fixture", err)
		}
	} else {
		backend = "herdr"
		data, err := os.ReadFile("../../../daynight/test/session/fixtures/v2/valid-archive.json")
		if err != nil {
			t.Fatal(err)
		}
		doc, err := v2.DecodeArchive(data)
		if err != nil {
			t.Fatal(err)
		}
		doc.SessionID, doc.ClaimID = id, claim
		doc.Owner.ProjectID, doc.Owner.TaskID, doc.Owner.OwnerUserID = f.project, f.task, f.p.UserID
		for i := range doc.Runs {
			doc.Runs[i].Owner = doc.Owner
		}
		body = encode(doc)
		if _, err = v2.DecodeArchive(body); err != nil {
			t.Fatal("invalid terminal migration fixture", err)
		}
		completeness, finalization = &doc.Completeness, &doc.FinalizationID
		receipt = encode(map[string]any{"finalizationId": doc.FinalizationID, "immutable": true})
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,project_id,task_id,claim_id,test_execution_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',CASE WHEN $9='web' THEN '{}'::jsonb END,$9,CASE WHEN $9='herdr' THEN '{}'::jsonb END)`, id, scope, project, task, claimID, testID, f.p.UserID, uuid.NewString(), backend); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(body)
	digest := hex.EncodeToString(hash[:])
	if ready {
		if _, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness,finalization_id,receipt) VALUES($1,'ready',$2,$3,$4,$5,$6,$7,$8)`, id, digest, len(body), id+"/"+digest+".json", version, completeness, finalization, receipt); err != nil {
			t.Fatal(err)
		}
		if _, err = f.s.files.Put(ctx, sessionarchive.Bucket, id+"/"+digest+".json", bytes.NewReader(body)); err != nil {
			t.Fatal(err)
		}
	}
	return archiveLayoutSeed{id, digest, body, namespace}
}

func migrateArchiveLayout(t *testing.T, f fixture, root string) (ArchiveLayoutMigrationSummary, error) {
	t.Helper()
	return EnsureSessionArchiveLayout(context.Background(), f.s.DB.Pool.Config().ConnConfig.ConnString(), root, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestArchiveLayoutMigrationPreservesTaskTestTerminalAndOrphanBytes(t *testing.T) {
	f, root := archiveLayoutTestFiles(t)
	seeds := []archiveLayoutSeed{seedArchiveLayout(t, f, "task", 1, true), seedArchiveLayout(t, f, "test", 1, true), seedArchiveLayout(t, f, "task", 2, true), seedArchiveLayout(t, f, "test", 1, false)}
	ctx := context.Background()
	before := map[string]string{}
	for _, seed := range seeds {
		if _, err := f.s.files.Put(ctx, sessionarchive.Bucket, seed.id+"/uncommitted.tmp", bytes.NewBufferString("orphan content")); err != nil {
			t.Fatal(err)
		}
		var metadata string
		err := f.s.DB.Pool.QueryRow(ctx, `SELECT (to_jsonb(a)-'object_path')::text FROM session_archives a WHERE session_id=$1`, seed.id).Scan(&metadata)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		before[seed.id] = metadata
	}
	summary, err := migrateArchiveLayout(t, f, root)
	if err != nil || summary.Phase != "complete" || summary.SessionCount != 4 || summary.MovedCount != 4 || summary.FileCount != 7 {
		t.Fatal(summary, err)
	}
	for _, seed := range seeds {
		if _, err := os.Stat(filepath.Join(root, sessionarchive.Bucket, seed.id)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatal("legacy namespace retained", err)
		}
		orphan, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory(), "uncommitted.tmp"))
		if err != nil || string(orphan) != "orphan content" {
			t.Fatal("orphan content lost", err)
		}
		if before[seed.id] == "" {
			continue
		}
		var object, metadata string
		if err = f.s.DB.Pool.QueryRow(ctx, `SELECT object_path,(to_jsonb(a)-'object_path')::text FROM session_archives a WHERE session_id=$1`, seed.id).Scan(&object, &metadata); err != nil || metadata != before[seed.id] {
			t.Fatal("non-layout archive metadata changed", err)
		}
		want, err := seed.namespace.ObjectPath(seed.digest)
		if err != nil || object != want {
			t.Fatal("manifest did not follow moved bytes", object, want, err)
		}
		data, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, object))
		if err != nil || !bytes.Equal(data, seed.body) {
			t.Fatal("raw archive bytes changed", err)
		}
	}
	again, err := migrateArchiveLayout(t, f, root)
	if err != nil || !again.AlreadyApplied || again.Phase != "complete" || again.MovedCount != 0 || again.SessionCount != 0 || again.FileCount != 0 || again.TotalBytes != 0 {
		t.Fatal("completed startup repeated its inventory", again, err)
	}
}

func TestArchiveLayoutMigrationResumesFileBeforeMetadataCommit(t *testing.T) {
	f, root := archiveLayoutTestFiles(t)
	seed := seedArchiveLayout(t, f, "task", 1, true)
	ctx := context.Background()
	if _, err := f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_archive_layout_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive layout update failure'; END $$; CREATE TRIGGER refuse_archive_layout_update BEFORE UPDATE ON session_archives FOR EACH ROW EXECUTE FUNCTION refuse_archive_layout_update()`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateArchiveLayout(t, f, root); err == nil {
		t.Fatal("failed metadata commit reported success")
	}
	if _, err := os.Lstat(filepath.Join(root, SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("failed migration published a completion marker", err)
	}
	var object string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT object_path FROM session_archives WHERE session_id=$1`, seed.id).Scan(&object); err != nil || object != seed.id+"/"+seed.digest+".json" {
		t.Fatal("failed metadata update committed", object, err)
	}
	if _, err := os.Stat(filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory())); err != nil {
		t.Fatal("durable move was lost after metadata failure", err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DROP TRIGGER refuse_archive_layout_update ON session_archives; DROP FUNCTION refuse_archive_layout_update()`); err != nil {
		t.Fatal(err)
	}
	summary, err := migrateArchiveLayout(t, f, root)
	if err != nil || summary.SessionCount != 1 || summary.MovedCount != 0 {
		t.Fatal("file-ahead metadata could not be recovered", summary, err)
	}
	want, _ := seed.namespace.ObjectPath(seed.digest)
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT object_path FROM session_archives WHERE session_id=$1`, seed.id).Scan(&object); err != nil || object != want {
		t.Fatal("recovered manifest did not point at original bytes", object, err)
	}
}

func TestArchiveLayoutMigrationPreflightRejectsUnsafeAndInconsistentStorage(t *testing.T) {
	for _, name := range []string{"unknown_session", "symlink", "special_file", "conflict", "corrupt", "missing", "wrong_path", "unknown_group", "invalid_owner", "invalid_shard", "misplaced_session", "bucket_file", "bucket_symlink"} {
		t.Run(name, func(t *testing.T) {
			f, root := archiveLayoutTestFiles(t)
			seed := seedArchiveLayout(t, f, "task", 1, true)
			bucket := filepath.Join(root, sessionarchive.Bucket)
			legacy := filepath.Join(bucket, seed.id)
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "unknown_session":
				must(os.Mkdir(filepath.Join(bucket, uuid.NewString()), 0o700))
			case "symlink":
				must(os.Symlink(t.TempDir(), filepath.Join(legacy, "linked")))
			case "special_file":
				must(os.Symlink("missing", filepath.Join(legacy, "dangling")))
			case "conflict":
				must(os.MkdirAll(filepath.Join(bucket, seed.namespace.Directory()), 0o700))
			case "corrupt":
				must(os.WriteFile(filepath.Join(legacy, seed.digest+".json"), []byte("corrupt"), 0o600))
			case "missing":
				must(os.Remove(filepath.Join(legacy, seed.digest+".json")))
			case "wrong_path":
				_, err := f.s.DB.Pool.Exec(context.Background(), `UPDATE session_archives SET object_path='unrelated/path.json' WHERE session_id=$1`, seed.id)
				must(err)
			case "unknown_group":
				must(os.MkdirAll(filepath.Join(bucket, "users", uuid.NewString()), 0o700))
			case "invalid_owner":
				must(os.MkdirAll(filepath.Join(bucket, "projects", "invalid"), 0o700))
			case "invalid_shard":
				must(os.MkdirAll(filepath.Join(bucket, "projects", f.project, "zz"), 0o700))
			case "misplaced_session":
				shard := "00"
				if seed.id[:2] == shard {
					shard = "01"
				}
				must(os.MkdirAll(filepath.Join(bucket, "projects", f.project, shard, seed.id), 0o700))
			case "bucket_file", "bucket_symlink":
				must(os.Rename(bucket, bucket+"-original"))
				if name == "bucket_file" {
					must(os.WriteFile(bucket, []byte("file"), 0o600))
				} else {
					must(os.Symlink(bucket+"-original", bucket))
				}
			}
			if _, err := migrateArchiveLayout(t, f, root); err == nil {
				t.Fatal("unsafe or inconsistent namespace migrated")
			}
			if _, err := os.Lstat(filepath.Join(root, SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("failed preflight published a completion marker", err)
			}
			var object string
			if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT object_path FROM session_archives WHERE session_id=$1`, seed.id).Scan(&object); err != nil {
				t.Fatal(err)
			}
			if name != "wrong_path" && object != seed.id+"/"+seed.digest+".json" {
				t.Fatal("preflight failure changed manifest", object)
			}
		})
	}
}

func TestArchiveLayoutMigrationConfigurationEmptyStorageAndCanceledSnapshot(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, database := range []string{"", "postgres://user:secret@bad%host/db", "postgres://user:secret@127.0.0.1:1/db?connect_timeout=1"} {
		if _, err := EnsureSessionArchiveLayout(context.Background(), database, t.TempDir(), logger); err == nil {
			t.Fatal("invalid database migration configuration accepted")
		}
	}
	f, root := archiveLayoutTestFiles(t)
	if summary, err := migrateArchiveLayout(t, f, root); err != nil || summary.SessionCount != 0 || summary.Phase != "complete" {
		t.Fatal("empty archive migration", summary, err)
	}
	if data, err := os.ReadFile(filepath.Join(root, SessionArchiveLayoutMarker)); err != nil || !bytes.Equal(data, []byte("{\"version\":1}\n")) {
		t.Fatal("empty startup did not persist completion", string(data), err)
	}
	if _, err := EnsureSessionArchiveLayout(context.Background(), f.s.DB.Pool.Config().ConnConfig.ConnString(), filepath.Join(root, "missing"), logger); err == nil {
		t.Fatal("missing storage root accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := EnsureSessionArchiveLayout(ctx, f.s.DB.Pool.Config().ConnConfig.ConnString(), root, logger); err == nil || !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost", err)
	}
}

func TestArchiveLayoutMigrationRejectsMetadataAndFileChangesAfterInventory(t *testing.T) {
	for _, change := range []string{"metadata", "content"} {
		t.Run(change, func(t *testing.T) {
			f, root := archiveLayoutTestFiles(t)
			seed := seedArchiveLayout(t, f, "task", 1, true)
			ctx := context.Background()
			connection, err := pgx.ConnectConfig(ctx, f.s.DB.Pool.Config().ConnConfig.Copy())
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close(ctx)
			storage, err := os.OpenRoot(root)
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()
			m := &archiveLayoutMigration{database: connection, root: storage, phase: "inventory", fileSync: (*os.File).Sync}
			records, err := m.snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = m.preflight(ctx, records); err != nil {
				t.Fatal(err)
			}
			var record *archiveLayoutRecord
			for _, r := range records {
				if r.id == seed.id {
					record = r
				}
			}
			if record == nil {
				t.Fatal("missing seeded archive")
			}
			if change == "metadata" {
				_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET registration_id=$2 WHERE id=$1`, seed.id, uuid.NewString())
			} else {
				err = os.WriteFile(filepath.Join(root, sessionarchive.Bucket, seed.id, "new-orphan"), []byte("new"), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.apply(ctx, record); err == nil {
				t.Fatal("changed snapshot applied")
			}
			if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket, seed.id)); err != nil {
				t.Fatal("rejected Session moved", err)
			}
		})
	}
}

func TestArchiveLayoutMigrationErrorsRetainUnderlyingCause(t *testing.T) {
	cause := errors.New("storage failure")
	failure := &ArchiveLayoutMigrationError{Phase: "placing", Category: "filesystem", Diagnostic: "Archive move failed.", Cause: cause}
	if !errors.Is(failure, cause) || failure.Error() != "Archive move failed." || reflect.DeepEqual(failure.Unwrap(), nil) {
		t.Fatal("migration error lost its cause")
	}
}

func TestArchiveLayoutMigrationRejectsReadyBytesAttributedToAnotherExecution(t *testing.T) {
	for _, variant := range []string{"task_claim", "test_execution", "terminal_task"} {
		t.Run(variant, func(t *testing.T) {
			f, root := archiveLayoutTestFiles(t)
			scope, version := "task", 1
			if variant == "test_execution" {
				scope = "test"
			}
			if variant == "terminal_task" {
				version = 2
			}
			seed := seedArchiveLayout(t, f, scope, version, true)
			var body []byte
			if version == 1 {
				doc, err := sp.DecodeArchive(seed.body)
				if err != nil {
					t.Fatal(err)
				}
				if scope == "task" {
					doc.ClaimID = uuid.NewString()
				} else {
					doc.TestExecutionID = uuid.NewString()
				}
				body = encode(doc)
				if _, err = sp.DecodeArchive(body); err != nil {
					t.Fatal("invalid misattributed fixture", err)
				}
			} else {
				doc, err := v2.DecodeArchive(seed.body)
				if err != nil {
					t.Fatal(err)
				}
				doc.Owner.TaskID = uuid.NewString()
				for i := range doc.Runs {
					doc.Runs[i].Owner = doc.Owner
				}
				body = encode(doc)
				if _, err = v2.DecodeArchive(body); err != nil {
					t.Fatal("invalid misattributed fixture", err)
				}
			}
			hash := sha256.Sum256(body)
			digest := hex.EncodeToString(hash[:])
			object := seed.id + "/" + digest + ".json"
			ctx := context.Background()
			if _, err := f.s.files.Put(ctx, sessionarchive.Bucket, object, bytes.NewReader(body)); err != nil {
				t.Fatal(err)
			}
			if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE session_archives SET object_path=$2,sha256=$3,byte_length=$4 WHERE session_id=$1`, seed.id, object, digest, len(body)); err != nil {
				t.Fatal(err)
			}
			_, err := migrateArchiveLayout(t, f, root)
			var failure *ArchiveLayoutMigrationError
			if !errors.As(err, &failure) || failure.Category != "content_corrupt" {
				t.Fatal("misattributed ready archive moved", err)
			}
			if _, err := os.Stat(filepath.Join(root, sessionarchive.Bucket, seed.id)); err != nil {
				t.Fatal("misattributed namespace moved", err)
			}
		})
	}
}
