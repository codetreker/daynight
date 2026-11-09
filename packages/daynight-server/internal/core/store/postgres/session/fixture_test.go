package session_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgbot "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

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

func membershipFixture(t *testing.T) (*postgres.Store, model.Principal, model.Principal, model.Project) {
	t.Helper()
	db := isolatedStore(t)
	admin, member, project := testutil.ProjectMembershipFixture(t, db)
	return db, admin, member, project
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
	defer tx.Rollback(context.Background())
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
	defer tx.Rollback(context.Background())
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
	defer tx.Rollback(context.Background())
	if err := fn(pgsession.New(tx)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func ptrTime(v time.Time) *time.Time { return &v }
