package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	migration026 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/026"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var schemaManagement struct {
	once sync.Once
	pool *pgxpool.Pool
	err  error
}

var rootDatabasePermits = make(chan struct{}, 2)

func parallelRootDatabaseTest(t *testing.T) {
	t.Helper()
	t.Parallel()
	rootDatabasePermits <- struct{}{}
	// Registered first, the permit cleanup runs after all fixture cleanups.
	t.Cleanup(func() { <-rootDatabasePermits })
}

const rootDatabaseEnv = "DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL"

var (
	sharedTestDatabaseURL = os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	rootTestDatabaseURL   = os.Getenv(rootDatabaseEnv)
)

func TestMain(m *testing.M) {
	if database := os.Getenv(rootDatabaseEnv); database != "" {
		if err := os.Setenv("DAYNIGHT_TEST_DATABASE_URL", database); err != nil {
			log.Fatal(err)
		}
		// Subprocesses inherit the selected URL and may supply their own fixture URL.
		if err := os.Unsetenv(rootDatabaseEnv); err != nil {
			log.Fatal(err)
		}
	}
	code := m.Run()
	if schemaManagement.pool != nil {
		schemaManagement.pool.Close()
	}
	os.Exit(code)
}

func TestDedicatedRootDatabaseRoutesFixtures(t *testing.T) {
	if rootTestDatabaseURL == "" {
		t.Skip("dedicated Store root database is not configured")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	expected, err := pgx.ParseConfig(rootTestDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := pgx.Connect(ctx, sharedTestDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shared.Close(cleanup); err != nil {
			t.Error(err)
		}
	})

	var sharedName, fixtureName string
	if err := shared.QueryRow(ctx, "SELECT current_database()").Scan(&sharedName); err != nil {
		t.Fatal(err)
	}
	if err := emptyPool(t).QueryRow(ctx, "SELECT current_database()").Scan(&fixtureName); err != nil {
		t.Fatal(err)
	}
	if fixtureName == sharedName || fixtureName != expected.Database {
		t.Fatalf("Store root fixture uses database %q, want %q distinct from shared database %q", fixtureName, expected.Database, sharedName)
	}
}

func scopedDatabaseURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	schemaManagement.once.Do(func() {
		schemaManagement.pool, schemaManagement.err = pgxpool.New(context.Background(), raw)
	})
	if schemaManagement.err != nil {
		t.Fatal(schemaManagement.err)
	}
	return testutil.ScopedDatabaseURLWithPool(t, schemaManagement.pool)
}

func isolatedStore(t *testing.T) *Store {
	t.Helper()
	return testutil.OpenStoreAt(t, Open, scopedDatabaseURL(t))
}

func closedStore(t *testing.T) *Store {
	t.Helper()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	return &Store{Pool: pool}
}

func checkFaultTriggerRemoved(ctx context.Context, database *Store, name, table string) error {
	var retained bool
	if err := database.Pool.QueryRow(ctx, `SELECT
 EXISTS(SELECT FROM pg_trigger WHERE tgname=$1 AND tgrelid=$2::regclass)
 OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.proname=$1 AND n.nspname=current_schema())`, name, table).Scan(&retained); err != nil {
		return err
	}
	if retained {
		return fmt.Errorf("fault trigger or function %s was retained", name)
	}
	return nil
}

func assertFaultTriggerRemoved(t *testing.T, database *Store, name, table string) {
	t.Helper()
	if err := checkFaultTriggerRemoved(t.Context(), database, name, table); err != nil {
		t.Fatal(err)
	}
}

func emptyPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), scopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func testAuthRecords(t *testing.T, s *Store) (model.User, model.Principal, model.Session) {
	t.Helper()
	return testutil.AuthRecords(t, s)
}

func testIdentityWrite(s *Store, ctx context.Context, operation func(IdentityScope) error) error {
	return testutil.IdentityWrite(ctx, s, operation)
}
func testAuthenticate(s *Store, ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	return testutil.Authenticate(ctx, s, kind, hash, now)
}
func deviceStoreHash(value string) []byte { return testutil.DeviceHash(value) }
func deviceStoreCredential(now time.Time) model.PersonalAccessToken {
	return testutil.DeviceCredential(now)
}

func (s *Store) CreateProject(ctx context.Context, id, name, repoURL string) (model.Project, error) {
	return testutil.CreateProject(ctx, s.Pool, s, id, name, repoURL)
}
func seedHistoricalProjectAdmin(ctx context.Context, s *Store, projectID string) error {
	return testutil.SeedHistoricalProjectAdmin(ctx, s.Pool, projectID)
}
func writeProjectForTest(s *Store, ctx context.Context, id string, operation func(ProjectWriteScope) error) error {
	return testutil.WriteProject(ctx, s, id, operation)
}
func (s *Store) CreatePrivateProject(ctx context.Context, principal model.Principal, id, name, repoURL string) (model.Project, error) {
	return testutil.CreatePrivateProject(ctx, s, principal, id, name, repoURL)
}
func (s *Store) CreateProjectInTeam(ctx context.Context, principal model.Principal, id, name, repoURL string, teamID *string) (model.Project, model.ProjectAccess, error) {
	return testutil.CreateProjectInTeam(ctx, s, principal, id, name, repoURL, teamID)
}

func fixtureTaskProperties(t *testing.T, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	return testutil.TaskProperties(t, worker)
}
func fixturePullRequests(t *testing.T, properties model.TaskProperties) []model.PullRequestProperty {
	t.Helper()
	return testutil.PullRequests(t, properties)
}
func fixtureWorker(t *testing.T, properties model.TaskProperties) *model.WorkerClaim {
	t.Helper()
	return testutil.Worker(t, properties)
}
func putTaskPropertyFixture(t *testing.T, database *Store, taskID, name string, value []byte) {
	t.Helper()
	testutil.PutTaskProperty(t, database.Pool, taskID, name, value)
}
func decodeHistoricalPropertiesFixture(data []byte) (model.TaskProperties, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	if _, exists := fields["worker"]; !exists {
		fields["worker"] = json.RawMessage("null")
	}
	normalized, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	return migration026.DecodeLegacyProperties(normalized)
}
func currentTaskFactsFixture(t *testing.T, database *Store) map[string]string {
	t.Helper()
	return testutil.CurrentTaskFacts(t, database.Pool)
}

func testCreateTeam(s *Store, ctx context.Context, userID, teamID, name string) (model.Team, error) {
	return testutil.CreateTeam(ctx, s, userID, teamID, name)
}
func testWriteTeam(s *Store, ctx context.Context, id string, operation func(TeamWriteDAO) error) error {
	return testutil.WriteTeam(ctx, s, id, operation)
}
func testWriteTeamRaw(s *Store, ctx context.Context, id string, operation func(TeamWriteDAO, pgx.Tx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	return transact(ctx, tx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return err
		}
		return operation(teamstore.NewWriter(tx, id), tx)
	})
}

func threadTestWrite(database *Store, ctx context.Context, operation func(ThreadScope) error) error {
	return testutil.ThreadWrite(ctx, database, operation)
}

func waitThreadClock(ctx context.Context) error { return testutil.WaitThreadClock(ctx) }
