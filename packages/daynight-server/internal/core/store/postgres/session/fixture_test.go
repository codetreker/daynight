package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgbot "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func prepareArchiveSession(t *testing.T, database *postgres.Store) (model.Task, string) {
	t.Helper()
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskDone)
	id, claim := uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.InsertTaskSession(t.Context(), store.SessionRegistration{
			Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID},
			ClaimID:  claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`),
			Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "archived"},
		})
	})
	return task, id
}

func prepareInlineMigration(t *testing.T, database *postgres.Store, migration string) (store.SessionResourceRecord, store.SessionResourceRecord) {
	t.Helper()
	_, id := prepareArchiveSession(t, database)
	length, digest, mediaType := "8", archiveHashOf("original"), "text/plain"
	previous := store.SessionResourceRecord{SessionID: id, MigrationID: migration, Resource: sp.Resource{ResourceID: uuid.NewString(), Name: "original", Status: "available", MediaType: &mediaType, ByteLength: &length, SHA256: &digest}}
	raw, err := json.Marshal(previous.Resource)
	if err != nil {
		t.Fatal(err)
	}
	var migrationValue any
	if migration != "" {
		migrationValue = migration
	}
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor,content,migration_id) VALUES($1,$2,$3,$4,$5)`, id, previous.Resource.ResourceID, raw, []byte("original"), migrationValue)
	next := previous
	next.BlobID, next.BlobPath, next.MigrationID = uuid.NewString(), "immutable/original", uuid.NewString()
	return previous, next
}

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func mustQueryExec(t *testing.T, db *postgres.Store, sql string, args ...any) {
	t.Helper()
	testutil.MustExec(t, db.Pool, sql, args...)
}

func queryID(number int) string { return testutil.QueryID(number) }

func queryProject(t *testing.T, db *postgres.Store, number int) model.Project {
	t.Helper()
	return testutil.QueryProject(t, db.Pool, db, number)
}

func queryTask(t *testing.T, db *postgres.Store, project string, number int, status model.TaskStatus) model.Task {
	t.Helper()
	return testutil.QueryTask(t, db, project, number, status)
}

func testAuthRecords(t *testing.T, db *postgres.Store) (model.User, model.Principal, model.Session) {
	t.Helper()
	return testutil.AuthRecords(t, db)
}

func prepareMembership(t *testing.T, db *postgres.Store) (model.Principal, model.Principal, model.Project) {
	t.Helper()
	return testutil.ProjectMembershipFixture(t, db)
}

func storedBotCandidate(t *testing.T, db *postgres.Store) (model.Bot, model.Principal) {
	t.Helper()
	return testutil.StoredBotCandidate(t, db)
}

func runtimeStoredBot(t *testing.T, db *postgres.Store) model.Bot {
	t.Helper()
	return testutil.RuntimeStoredBot(t, db)
}

func sessionBotDAOTransaction(t *testing.T, db *postgres.Store, operation func(store.SessionDAO, store.BotWriteDAO) error) {
	t.Helper()
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if err := operation(pgsession.New(tx), pgbot.NewWriter(tx)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func sessionProjectDAOTransaction(t *testing.T, db *postgres.Store, projectID string, operation func(store.ProjectSessionDAO) error) {
	t.Helper()
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if err := operation(pgsession.NewProjectDAO(tx, projectID)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func sessionDAOTransaction(t *testing.T, db *postgres.Store, fn func(store.SessionDAO) error) {
	t.Helper()
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if err := fn(pgsession.New(tx)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func ptrTime(v time.Time) *time.Time { return &v }

func prepareImageSession(t *testing.T, db *postgres.Store) (string, model.Principal) {
	t.Helper()
	_, actor, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id := uuid.NewString()
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		if e := d.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: uuid.NewString(), OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}}); e != nil {
			return e
		}
		_, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		return e
	})
	return id, actor
}

type sessionStoreSequence struct {
	name   string
	last   int64
	called bool
}

type sessionStoreSeed struct {
	name string
	rows string
}

type sessionStoreSuite struct {
	database  *postgres.Store
	truncate  string
	sequences []sessionStoreSequence
	seeds     []sessionStoreSeed
	used      bool
}

func newSessionStoreSuite(t *testing.T) *sessionStoreSuite {
	t.Helper()
	suite := &sessionStoreSuite{database: isolatedStore(t)}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var schema string
	if err := suite.database.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if suite.database.Pool.Config().ConnConfig.RuntimeParams["application_name"] == "" {
		t.Fatal("shared Session fixture has no application identity")
	}
	seedNames := []string{"oauth_authorization_cleanup_cursor", "oauth_credential_cleanup_cursor", "private_transfer_ledger", "schema_migrations", "webhook_policies"}
	for _, name := range seedNames {
		qualified := pgx.Identifier{schema, name}.Sanitize()
		suite.seeds = append(suite.seeds, sessionStoreSeed{name: qualified, rows: suite.seedRows(t, ctx, qualified)})
	}
	rows, err := suite.database.Pool.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename<>ALL($2::text[]) ORDER BY tablename`, schema, seedNames)
	if err != nil {
		t.Fatal(err)
	}
	var names, qualified []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		names = append(names, name)
		qualified = append(qualified, pgx.Identifier{schema, name}.Sanitize())
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	mutableTables := []string{
		"assistant_task_appendix",
		"assistant_task_claim_operations",
		"assistant_task_events",
		"assistant_task_inquiries",
		"assistant_task_items",
		"assistant_task_manual_versions",
		"assistant_task_proposals",
		"assistant_task_records",
		"assistant_tasks",
		"bot_configuration_preferences",
		"bot_effort_preferences",
		"bot_model_preferences",
		"bot_worker_preferences",
		"bots",
		"device_authorization_limits",
		"device_authorizations",
		"login_transactions",
		"oauth_access_tokens",
		"oauth_authorizations",
		"oauth_clients",
		"oauth_grants",
		"oauth_refresh_tokens",
		"personal_access_tokens",
		"private_transfers",
		"private_upload_chunks",
		"project_github",
		"project_github_pending_prs",
		"project_grants",
		"project_invitations",
		"project_ownership",
		"project_pull_requests",
		"projects",
		"session_archive_bundles",
		"session_archive_chunks",
		"session_archive_files",
		"session_archive_migrations",
		"session_archives",
		"session_events",
		"session_image_captures",
		"session_image_chunks",
		"session_image_uploads",
		"session_media_rates",
		"session_media_requests",
		"session_operation_intents",
		"session_operations",
		"session_recording_evidence",
		"session_resource_leases",
		"session_resource_references",
		"session_resource_state",
		"session_resources",
		"session_source_hashes",
		"session_timeline",
		"sessions",
		"task_attachments",
		"task_dependencies",
		"task_properties",
		"task_sessions",
		"task_steps",
		"task_thread_messages",
		"task_threads",
		"tasks",
		"team_invitations",
		"team_members",
		"teams",
		"users",
		"webhook_attempts",
		"webhook_bindings",
		"webhook_deliveries",
		"webhook_delivery_matches",
		"webhook_endpoint_waits",
		"webhook_endpoints",
		"webhook_events",
		"webhook_operations",
		"webhook_signing_keys",
		"webhook_subscriptions",
		"worker_prompts",
		"workers",
	}
	if !slices.Equal(names, mutableTables) {
		t.Fatalf("shared Session fixture mutable tables changed: %v", names)
	}
	suite.truncate = "TRUNCATE " + strings.Join(qualified, ",") + " RESTART IDENTITY"
	rows, err = suite.database.Pool.Query(ctx, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname`, schema)
	if err != nil {
		t.Fatal(err)
	}
	names = nil
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names, []string{"bots_creation_order_seq", "project_grant_versions", "team_member_versions", "webhook_delivery_queue_order_seq"}) {
		t.Fatalf("shared Session fixture sequences changed: %v", names)
	}
	for _, name := range names {
		sequence := sessionStoreSequence{name: pgx.Identifier{schema, name}.Sanitize()}
		if err := suite.database.Pool.QueryRow(ctx, "SELECT last_value,is_called FROM "+sequence.name).Scan(&sequence.last, &sequence.called); err != nil {
			t.Fatal(err)
		}
		suite.sequences = append(suite.sequences, sequence)
	}
	return suite
}

func (suite *sessionStoreSuite) run(parent *testing.T, name string, test func(*testing.T, *postgres.Store)) {
	parent.Helper()
	ran := false
	passed := parent.Run(name, func(t *testing.T) {
		ran = true
		if suite.used {
			suite.reset(t)
		}
		suite.used = true
		test(t, suite.database)
	})
	if !ran {
		return
	}
	// The child context is cancelled by Run; all child defers and cleanups have
	// finished, so observe resources with the still-live parent context.
	suite.assertReusable(parent)
	suite.assertSeeds(parent)
	if !passed {
		parent.FailNow()
	}
}

func (suite *sessionStoreSuite) reset(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := suite.database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if _, err := tx.Exec(ctx, suite.truncate); err != nil {
		t.Fatal(err)
	}
	// setval also restores the standalone sequences and is not transactional.
	for _, sequence := range suite.sequences {
		if _, err := tx.Exec(ctx, `SELECT setval($1::regclass,$2,$3)`, sequence.name, sequence.last, sequence.called); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	observe, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	for _, sequence := range suite.sequences {
		var last int64
		var called bool
		if err := suite.database.Pool.QueryRow(observe, "SELECT last_value,is_called FROM "+sequence.name).Scan(&last, &called); err != nil {
			t.Fatal(err)
		}
		if last != sequence.last || called != sequence.called {
			t.Fatalf("shared Session sequence %s was not restored: got %d/%v, want %d/%v", sequence.name, last, called, sequence.last, sequence.called)
		}
	}
}

func (suite *sessionStoreSuite) assertReusable(t *testing.T) {
	t.Helper()
	testutil.AssertPoolReusable(t, suite.database.Pool)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	application := suite.database.Pool.Config().ConnConfig.RuntimeParams["application_name"]
	for {
		var count int
		var backends string
		err := suite.database.Pool.QueryRow(ctx, `SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('pid',pid,'state',state,'waitType',wait_event_type,'wait',wait_event,'query',query)),'[]'::jsonb)::text
 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()
 AND (state IS DISTINCT FROM 'idle' OR xact_start IS NOT NULL OR wait_event_type='Lock')`, application).Scan(&count, &backends)
		if err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			return
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("shared Session fixture retained active backends: %s: %v", backends, err)
		}
	}
}

func (suite *sessionStoreSuite) seedRows(t *testing.T, ctx context.Context, name string) string {
	t.Helper()
	var rows string
	if err := suite.database.Pool.QueryRow(ctx, "SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb)::text FROM "+name+" AS row").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func (suite *sessionStoreSuite) assertSeeds(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, seed := range suite.seeds {
		if rows := suite.seedRows(t, ctx, seed.name); rows != seed.rows {
			t.Fatalf("shared Session seed %s changed: got %s, want %s", seed.name, rows, seed.rows)
		}
	}
}

func rollbackSessionTestTransaction(t *testing.T, tx pgx.Tx) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("rollback Session test transaction: %v", err)
	}
}
