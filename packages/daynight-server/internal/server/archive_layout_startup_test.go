package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const startupArchiveLayoutLock int64 = 0x444e5341524348

type startupArchiveSeed struct {
	id, digest, metadata, expectedPath string
	body                               []byte
}

func archiveStartupConfig(t *testing.T) (Config, *store.Store) {
	t.Helper()
	database := projectTestStore(t)
	config := configuredTestConfig()
	config.DatabaseURL = database.Pool.Config().ConnConfig.ConnString()
	config.StorageRoot = testStorageRoot(t)
	return config, database
}

func seedStartupArchives(t *testing.T, config Config, database *store.Store) []startupArchiveSeed {
	t.Helper()
	ctx := t.Context()
	owner, worker, bot, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now())`, []any{owner}},
		{`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, []any{owner, worker}},
		{`INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result) VALUES($1,$2,$3,'Archive owner',$4,'{}','{}','{"state":"pending"}')`, []any{bot, owner, worker, strings.Repeat("a", 64)}},
	} {
		if _, err := database.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	seeds := []startupArchiveSeed{}
	for _, kind := range []string{"task", "test", "bot", "terminal"} {
		id, claim, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
		scope, backend := "task", "web"
		version := 1
		var projectID, taskID, claimID, testID, botID, completeness, finalization *string
		var receipt []byte
		projectID, taskID, claimID = &project, &task, &claim
		namespaceKind, namespaceOwner := sessionarchive.Projects, project
		if kind == "test" || kind == "bot" {
			scope, projectID, taskID, claimID, testID = "test", nil, nil, nil, &execution
			namespaceKind, namespaceOwner = sessionarchive.Users, owner
			if kind == "bot" {
				botID = &bot
			}
		}
		var body []byte
		if kind == "terminal" {
			backend, version = "herdr", 2
			raw, err := os.ReadFile("../../../daynight/test/session/fixtures/v2/valid-archive.json")
			if err != nil {
				t.Fatal(err)
			}
			doc, err := v2.DecodeArchive(raw)
			if err != nil {
				t.Fatal(err)
			}
			doc.SessionID, doc.ClaimID = id, claim
			doc.Owner.ProjectID, doc.Owner.TaskID, doc.Owner.OwnerUserID = project, task, owner
			for i := range doc.Runs {
				doc.Runs[i].Owner = doc.Owner
			}
			body, err = json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			completeness, finalization = &doc.Completeness, &doc.FinalizationID
			receipt = []byte(`{"immutable":"startup fixture"}`)
		} else {
			fence := sp.Fence{SessionID: id, ExecutionGeneration: "1", ClaimID: claim}
			if scope == "test" {
				fence.ClaimID, fence.TestExecutionID = "", execution
			}
			var err error
			body, err = json.Marshal(sp.ArchiveDocument{Fence: fence, SchemaVersion: 1, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
			if err != nil {
				t.Fatal(err)
			}
		}
		hash := sha256.Sum256(body)
		digest := hex.EncodeToString(hash[:])
		if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,project_id,task_id,claim_id,test_execution_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,bot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',CASE WHEN $9='web' THEN '{}'::jsonb END,$9,CASE WHEN $9='herdr' THEN '{}'::jsonb END,$10)`, id, scope, projectID, taskID, claimID, testID, owner, uuid.NewString(), backend, botID); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness,finalization_id,receipt) VALUES($1,'ready',$2,$3,$4,$5,$6,$7,$8)`, id, digest, len(body), id+"/"+digest+".json", version, completeness, finalization, receipt); err != nil {
			t.Fatal(err)
		}
		namespace, err := sessionarchive.NewNamespace(namespaceKind, namespaceOwner, id)
		if err != nil {
			t.Fatal(err)
		}
		expected, err := namespace.ObjectPath(digest)
		if err != nil {
			t.Fatal(err)
		}
		seed := startupArchiveSeed{id: id, digest: digest, body: body, expectedPath: expected}
		if err := database.Pool.QueryRow(ctx, `SELECT (to_jsonb(a)-'object_path')::text FROM session_archives a WHERE session_id=$1`, id).Scan(&seed.metadata); err != nil {
			t.Fatal(err)
		}
		directory := filepath.Join(config.StorageRoot, sessionarchive.Bucket, id)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		for name, content := range map[string][]byte{digest + ".json": body, "orphan.tmp": []byte("uncommitted bytes")} {
			if err := os.WriteFile(filepath.Join(directory, name), content, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		seeds = append(seeds, seed)
	}
	return seeds
}

func verifyArchiveStartupLayout(ctx context.Context, config Config, dependencies Dependencies, seeds []startupArchiveSeed) error {
	marker, err := os.ReadFile(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker))
	if err != nil {
		return fmt.Errorf("handler composed before archive completion marker: %w", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(marker, &fields); err != nil || len(fields) != 1 || fields["version"] != float64(1) {
		return errors.New("handler received an invalid archive completion marker")
	}
	for _, seed := range seeds {
		var object, metadata string
		if err := dependencies.Store.Pool.QueryRow(ctx, `SELECT object_path,(to_jsonb(a)-'object_path')::text FROM session_archives a WHERE session_id=$1`, seed.id).Scan(&object, &metadata); err != nil {
			return err
		}
		if object != seed.expectedPath || metadata != seed.metadata {
			return errors.New("startup changed immutable archive metadata or left a legacy object address")
		}
		file, err := dependencies.Files.Open(ctx, sessionarchive.Bucket, object)
		if err != nil {
			return err
		}
		data, readErr := io.ReadAll(file.Body)
		if err := errors.Join(readErr, file.Body.Close()); err != nil {
			return err
		}
		if !bytes.Equal(data, seed.body) {
			return errors.New("startup changed raw archive bytes")
		}
		if _, err := os.Stat(filepath.Join(config.StorageRoot, sessionarchive.Bucket, seed.id)); !errors.Is(err, fs.ErrNotExist) {
			return errors.New("startup left a legacy archive directory")
		}
		orphan, err := os.ReadFile(filepath.Join(config.StorageRoot, sessionarchive.Bucket, filepath.Dir(seed.expectedPath), "orphan.tmp"))
		if err != nil || string(orphan) != "uncommitted bytes" {
			return errors.New("startup lost orphan archive bytes")
		}
	}
	return nil
}

func stopStartupRuntime(t *testing.T, running *Runtime) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := running.Run(ctx); err != nil {
		t.Error("startup runtime cleanup:", err)
	}
}

func TestStartupMigratesArchiveScopesBeforeCompositionAndThenSkipsInventory(t *testing.T) {
	config, database := archiveStartupConfig(t)
	seeds := seedStartupArchives(t, config, database)
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	start := func() *Runtime {
		t.Helper()
		running, err := Start(t.Context(), config, logger, func(dependencies Dependencies) (http.Handler, error) {
			return http.NotFoundHandler(), verifyArchiveStartupLayout(t.Context(), config, dependencies, seeds)
		})
		if err != nil {
			t.Fatal(err)
		}
		return running
	}
	stopStartupRuntime(t, start())
	unknown := filepath.Join(config.StorageRoot, sessionarchive.Bucket, uuid.NewString())
	if err := os.Mkdir(unknown, 0o700); err != nil {
		t.Fatal(err)
	}
	// A repeated inventory would reject this unrelated, unregistered namespace.
	// The completion marker makes later startup independent of archive volume.
	stopStartupRuntime(t, start())
	if !strings.Contains(logs.String(), `"already_applied":true`) || !strings.Contains(logs.String(), `"moved":4`) {
		t.Fatalf("startup did not report first conversion and subsequent marker skip: %s", &logs)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatal("marker skip inspected or modified unrelated storage", err)
	}
}

func assertNoStartupAdmission(t *testing.T, config Config, composed *atomic.Int64) {
	t.Helper()
	if composed.Load() != 0 {
		t.Fatal("failed or blocked migration reached handler composition")
	}
	listener, err := net.Listen("tcp", config.ListenAddress)
	if err != nil {
		t.Fatalf("failed or blocked migration retained a listener: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
}

func allocateStartupAddress(t *testing.T, config *Config) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config.ListenAddress = listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertStartupStorageReleased(t *testing.T, config Config) {
	t.Helper()
	if goruntime.GOOS != "linux" {
		return
	}
	root, err := filepath.Abs(config.StorageRoot)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		link, err := os.Readlink(filepath.Join("/proc/self/fd", entry.Name()))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			t.Fatal(err)
		}
		if link == root || strings.HasPrefix(link, root+string(filepath.Separator)) {
			t.Fatalf("failed startup retained storage handle %s", entry.Name())
		}
	}
}

func startupDatabaseConnectionCount(t *testing.T, database *store.Store) int {
	t.Helper()
	var count int
	application := database.Pool.Config().ConnConfig.RuntimeParams["application_name"]
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func assertStartupDatabaseConnectionsReleased(t *testing.T, database *store.Store, baseline int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	application := database.Pool.Config().ConnConfig.RuntimeParams["application_name"]
	for {
		var count int
		if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count <= baseline {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("failed startup retained database connections: baseline=%d current=%d", baseline, count)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestStartupArchiveFailureLeavesNoMarkerAndNextStartupResumes(t *testing.T) {
	config, database := archiveStartupConfig(t)
	seeds := seedStartupArchives(t, config, database)
	allocateStartupAddress(t, &config)
	if _, err := database.Pool.Exec(t.Context(), `CREATE FUNCTION refuse_startup_archive_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL startup failure'; END $$; CREATE TRIGGER refuse_startup_archive_update BEFORE UPDATE ON session_archives FOR EACH ROW EXECUTE FUNCTION refuse_startup_archive_update()`); err != nil {
		t.Fatal(err)
	}
	var composed atomic.Int64
	baseline := startupDatabaseConnectionCount(t, database)
	running, err := Start(t.Context(), config, testLogger(), func(Dependencies) (http.Handler, error) {
		composed.Add(1)
		return http.NotFoundHandler(), nil
	})
	var migration *sessionrelay.ArchiveLayoutMigrationError
	if running != nil || !errors.As(err, &migration) || migration.Phase != "metadata" {
		t.Fatalf("startup hid failed archive metadata publication: %v", err)
	}
	assertNoStartupAdmission(t, config, &composed)
	assertStartupStorageReleased(t, config)
	assertStartupDatabaseConnectionsReleased(t, database, baseline)
	if _, err := os.Stat(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("failed startup published a completion marker: %v", err)
	}
	if _, err := database.Pool.Exec(t.Context(), `DROP TRIGGER refuse_startup_archive_update ON session_archives; DROP FUNCTION refuse_startup_archive_update()`); err != nil {
		t.Fatal(err)
	}
	running, err = Start(t.Context(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
		return http.NotFoundHandler(), verifyArchiveStartupLayout(t.Context(), config, dependencies, seeds)
	})
	if err != nil {
		t.Fatal("next startup could not resume moved bytes:", err)
	}
	stopStartupRuntime(t, running)
}

func TestStartupInvalidArchiveMarkerPreventsAdmission(t *testing.T) {
	config, database := archiveStartupConfig(t)
	allocateStartupAddress(t, &config)
	if err := os.WriteFile(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker), []byte(`{"version":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var composed atomic.Int64
	baseline := startupDatabaseConnectionCount(t, database)
	running, err := Start(t.Context(), config, testLogger(), func(Dependencies) (http.Handler, error) {
		composed.Add(1)
		return http.NotFoundHandler(), nil
	})
	var migration *sessionrelay.ArchiveLayoutMigrationError
	if running != nil || !errors.As(err, &migration) || migration.Category != "invalid_marker" {
		t.Fatalf("invalid archive marker was ignored: %v", err)
	}
	assertNoStartupAdmission(t, config, &composed)
	assertStartupStorageReleased(t, config)
	assertStartupDatabaseConnectionsReleased(t, database, baseline)
}

type cancelArchiveReadyLogHandler struct {
	slog.Handler
	cancel context.CancelFunc
}

func (h cancelArchiveReadyLogHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Message == "session archive layout ready" {
		h.cancel()
	}
	return h.Handler.Handle(ctx, record)
}

func TestStartupCancellationAfterArchiveCompletionPreventsAdmission(t *testing.T) {
	config, database := archiveStartupConfig(t)
	allocateStartupAddress(t, &config)
	baseline := startupDatabaseConnectionCount(t, database)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	logger := slog.New(cancelArchiveReadyLogHandler{Handler: slog.NewJSONHandler(io.Discard, nil), cancel: cancel})
	var composed atomic.Int64
	running, err := Start(ctx, config, logger, func(Dependencies) (http.Handler, error) {
		composed.Add(1)
		return http.NotFoundHandler(), nil
	})
	if running != nil {
		stopStartupRuntime(t, running)
		t.Fatal("canceled startup returned an admitted Runtime")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("startup lost cancellation after archive completion: %v", err)
	}
	assertNoStartupAdmission(t, config, &composed)
	assertStartupStorageReleased(t, config)
	assertStartupDatabaseConnectionsReleased(t, database, baseline)
	marker, err := os.ReadFile(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker))
	if err != nil {
		t.Fatal("listen cancellation removed completed archive migration:", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(marker, &fields); err != nil || len(fields) != 1 || fields["version"] != float64(1) {
		t.Fatal("listen cancellation invalidated the archive completion marker")
	}
	running, err = Start(t.Context(), config, testLogger(), func(Dependencies) (http.Handler, error) {
		return http.NotFoundHandler(), nil
	})
	if err != nil {
		t.Fatal("next startup could not reuse completed archive migration:", err)
	}
	stopStartupRuntime(t, running)
}

func holdStartupArchiveLock(t *testing.T, config Config) *pgx.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	connection, err := pgx.Connect(ctx, config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := connection.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	if _, err := connection.Exec(ctx, "SELECT pg_advisory_lock($1)", startupArchiveLayoutLock); err != nil {
		t.Fatal(err)
	}
	return connection
}

func awaitStartupArchiveLockWaiters(t *testing.T, database *store.Store, count int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	application := database.Pool.Config().ConnConfig.RuntimeParams["application_name"]
	for {
		var waiting int
		if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND query='SELECT pg_advisory_lock($1)' AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'`, application).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("startup did not wait on archive layout serialization")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

type archiveStartupResult struct {
	running *Runtime
	err     error
}

func TestConcurrentStartupsSerializeArchiveConversionAndMarkerAdmission(t *testing.T) {
	config, database := archiveStartupConfig(t)
	seeds := seedStartupArchives(t, config, database)
	blocker := holdStartupArchiveLock(t, config)
	ctx, cancel := context.WithCancel(t.Context())
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	var composed atomic.Int64
	results := make(chan archiveStartupResult, 2)
	remaining := 2
	t.Cleanup(func() {
		cancel()
		for range remaining {
			result := await(t, results)
			if result.running != nil {
				stopStartupRuntime(t, result.running)
			}
		}
	})
	for range 2 {
		go func() {
			running, err := Start(ctx, config, logger, func(dependencies Dependencies) (http.Handler, error) {
				composed.Add(1)
				return http.NotFoundHandler(), verifyArchiveStartupLayout(ctx, config, dependencies, seeds)
			})
			results <- archiveStartupResult{running, err}
		}()
	}
	awaitStartupArchiveLockWaiters(t, database, 2)
	if composed.Load() != 0 {
		t.Fatal("concurrent startup composed a handler before archive lock acquisition")
	}
	if _, err := os.Stat(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("blocked startup published a completion marker: %v", err)
	}
	if _, err := blocker.Exec(t.Context(), "SELECT pg_advisory_unlock($1)", startupArchiveLayoutLock); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		result := await(t, results)
		remaining--
		if result.running != nil {
			t.Cleanup(func() { stopStartupRuntime(t, result.running) })
		}
		if result.err != nil {
			t.Fatal("serialized startup failed:", result.err)
		}
	}
	if composed.Load() != 2 || strings.Count(logs.String(), `"already_applied":false`) != 1 || strings.Count(logs.String(), `"already_applied":true`) != 1 {
		t.Fatalf("concurrent startups did not share one completed conversion: %s", &logs)
	}
}

func TestArchiveStartupLockWaitUsesRootCancellationAndFreshListenTimeout(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(fmt.Sprint(canceled), func(t *testing.T) {
			config, database := archiveStartupConfig(t)
			seeds := seedStartupArchives(t, config, database)
			allocateStartupAddress(t, &config)
			config.StartupTimeout = time.Second
			blocker := holdStartupArchiveLock(t, config)
			baseline := startupDatabaseConnectionCount(t, database)
			ctx, cancel := context.WithCancel(t.Context())
			var composed atomic.Int64
			results := make(chan archiveStartupResult, 1)
			pending := true
			t.Cleanup(func() {
				cancel()
				if pending {
					result := await(t, results)
					if result.running != nil {
						stopStartupRuntime(t, result.running)
					}
				}
			})
			go func() {
				running, err := Start(ctx, config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
					composed.Add(1)
					return http.NotFoundHandler(), verifyArchiveStartupLayout(ctx, config, dependencies, seeds)
				})
				results <- archiveStartupResult{running, err}
			}()
			awaitStartupArchiveLockWaiters(t, database, 1)
			timer := time.NewTimer(config.StartupTimeout * 2)
			defer timer.Stop()
			select {
			case result := <-results:
				pending = false
				if result.running != nil {
					stopStartupRuntime(t, result.running)
				}
				t.Fatalf("archive lock wait inherited the database bootstrap deadline: %v", result.err)
			case <-timer.C:
			}
			assertNoStartupAdmission(t, config, &composed)
			if canceled {
				cancel()
			} else if _, err := blocker.Exec(t.Context(), "SELECT pg_advisory_unlock($1)", startupArchiveLayoutLock); err != nil {
				t.Fatal(err)
			}
			result := await(t, results)
			pending = false
			if result.running != nil {
				t.Cleanup(func() { stopStartupRuntime(t, result.running) })
			}
			if canceled {
				if result.running != nil || !errors.Is(result.err, context.Canceled) {
					t.Fatalf("startup ignored root cancellation: %v", result.err)
				}
				assertNoStartupAdmission(t, config, &composed)
				assertStartupStorageReleased(t, config)
				assertStartupDatabaseConnectionsReleased(t, database, baseline)
				if _, err := os.Stat(filepath.Join(config.StorageRoot, sessionrelay.SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("canceled startup published a marker: %v", err)
				}
			} else if result.err != nil || result.running == nil || composed.Load() != 1 {
				t.Fatalf("startup did not listen after migration outlasted its bootstrap timer: %v", result.err)
			}
		})
	}
}
