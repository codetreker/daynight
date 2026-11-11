//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestVerifyStorageProcessHelper(t *testing.T) {
	if os.Getenv("DAYNIGHT_VERIFY_STORAGE_HELPER") != "1" {
		return
	}
	os.Exit(run(context.Background(), []string{"verify-storage", "--root", os.Getenv("DAYNIGHT_TEST_ROOT")}, os.LookupEnv, os.Stderr))
}

func TestVerifyStorageCommandRejectsMissingConfigurationAndRedactsFailures(t *testing.T) {
	for _, values := range []map[string]string{{}, {"DAYNIGHT_DATABASE_URL": "postgres://secret-user:secret-password@bad%host/db", "DAYNIGHT_STORAGE_ROOT": "/secret/root"}} {
		var output bytes.Buffer
		if code := run(t.Context(), []string{"verify-storage", "--root", testStorageRoot(t)}, lookupTestEnvironment(values), &output); code != 1 {
			t.Fatal(code)
		}
		if strings.Contains(output.String(), "secret-") || strings.Contains(output.String(), "/secret/root") {
			t.Fatal("sensitive reader failure", output.String())
		}
	}
}

func runBackupVerifierProcess(t *testing.T, database, root string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configRoot := testStorageRoot(t)
	writeTestConfig(t, configRoot, map[string]any{"database": map[string]any{"url": database}, "storage": map[string]any{"root": root}})
	command := exec.CommandContext(ctx, executable, "-test.run=^TestVerifyStorageProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "DAYNIGHT_TEST_ROOT="+configRoot, "DAYNIGHT_VERIFY_STORAGE_HELPER=1")
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatal("backup verifier did not exit", string(output))
	}
	if err == nil && !strings.Contains(string(output), "Storage backup closure verified.") {
		t.Fatal("missing closure receipt", string(output))
	}
	return err == nil
}

// The database dump and file copy are taken after closing every fixture writer.
// A restored verifier uses only those copied bytes and never starts a Provider.
func TestVerifyStorageProcessChecksDatabaseDumpAndVolumeRestore(t *testing.T) {
	dumpCommand := os.Getenv("DAYNIGHT_TEST_PG_DUMP")
	if dumpCommand == "" {
		dumpCommand = "pg_dump"
	}
	pgdump, err := exec.LookPath(dumpCommand)
	if err != nil {
		t.Fatal("pg_dump is required")
	}
	restoreCommand := os.Getenv("DAYNIGHT_TEST_PSQL")
	if restoreCommand == "" {
		restoreCommand = "psql"
	}
	psql, err := exec.LookPath(restoreCommand)
	if err != nil {
		t.Fatal("psql is required")
	}
	values := processAPIEnvironment(t)
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	id, owner, execution, resourceID, blobID, fileID, controller, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); err != nil {
		t.Fatal(err)
	}
	digest := func(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
	original := []byte("restored original")
	length, hash, mime := "17", digest(original), "text/plain"
	resource := sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"original"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	timeline, _ := json.Marshal(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: id, Fence: sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}, Provider: "codex", ControllerID: controller, ControllerInstanceID: instance, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: digest(timeline), ByteLength: jsonNumber(len(timeline))}, Resources: []sp.ArchiveResourceReference{{Resource: resource, BlobID: &blobID}}, Completeness: "complete"}
	body, _ := json.Marshal(manifest)
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath, err := namespace.ObjectPath(digest(body))
	if err != nil {
		t.Fatal(err)
	}
	blobPath := namespace.Directory() + "/blobs/" + blobID

	files, err := local.New(values["DAYNIGHT_STORAGE_ROOT"])
	if err != nil {
		t.Fatal(err)
	}
	put := func(bucket, path string, data []byte) {
		t.Helper()
		if _, err := files.Put(ctx, bucket, path, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
	}
	put("session-resources", blobPath, original)
	put("session-archives", manifestPath, body)
	put("session-archives", namespace.Directory()+"/files/"+fileID+"/content", timeline)
	if err = files.Close(); err != nil {
		t.Fatal(err)
	}
	descriptor, _ := json.Marshal(resource)
	if _, err = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$4,$5)`, id, resourceID, descriptor, blobID, blobPath); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness) VALUES($1,'ready',$2,$3,$4,3,'complete')`, id, digest(body), len(body), manifestPath); err != nil {
		t.Fatal(err)
	}
	database.Close()
	sourceURL, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	schema := sourceURL.Query().Get("search_path")
	dumpURL := *sourceURL
	dumpQuery := dumpURL.Query()
	dumpQuery.Del("search_path")
	dumpURL.RawQuery = dumpQuery.Encode()
	dump := exec.CommandContext(ctx, pgdump, "--no-owner", "--no-acl", "--schema="+schema, "--dbname="+dumpURL.String())
	var dumpErrors bytes.Buffer
	dump.Stderr = &dumpErrors
	dumpBytes, err := dump.Output()
	if err != nil {
		t.Fatal("database backup failed", err, dumpErrors.String())
	}
	admin, err := pgxpool.New(ctx, os.Getenv("DAYNIGHT_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	restoredName := "backup_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{restoredName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{restoredName}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Error(err)
		}
	})
	restoredURL := *sourceURL
	restoredURL.Path = "/" + restoredName
	restoreURL := dumpURL
	restoreURL.Path = "/" + restoredName
	restore := exec.CommandContext(ctx, psql, "--set=ON_ERROR_STOP=1", "--dbname="+restoreURL.String())
	restore.Stdin = bytes.NewReader(dumpBytes)
	if output, err := restore.CombinedOutput(); err != nil {
		t.Fatal("database restore failed", err, string(output))
	}
	volume := testStorageRoot(t)
	if err = os.CopyFS(volume, os.DirFS(values["DAYNIGHT_STORAGE_ROOT"])); err != nil {
		t.Fatal(err)
	}
	if !runBackupVerifierProcess(t, restoredURL.String(), volume) {
		t.Fatal("restored closed backup failed verification")
	}
	// The restored reader must not fetch the original volume to hide a lost object.
	if err = os.Remove(filepath.Join(volume, "session-resources", filepath.FromSlash(blobPath))); err != nil {
		t.Fatal(err)
	}
	if runBackupVerifierProcess(t, restoredURL.String(), volume) {
		t.Fatal("restored missing known original reported success")
	}
}

func jsonNumber(value int) string { data, _ := json.Marshal(value); return string(data) }
