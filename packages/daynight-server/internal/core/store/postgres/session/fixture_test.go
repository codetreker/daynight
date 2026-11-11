package session_test

import (
	"context"
	"encoding/json"
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
)

func sessionArchiveLockFixture(t *testing.T) (*postgres.Store, model.Task, string) {
	t.Helper()
	database := isolatedStore(t)
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
	return database, task, id
}

func archiveResourceMigrationBoundaryFixture(t *testing.T, migration string) (*postgres.Store, store.SessionResourceRecord, store.SessionResourceRecord) {
	t.Helper()
	database, _, id := sessionArchiveLockFixture(t)
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
	return database, previous, next
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

func imageLedgerSession(t *testing.T) (*postgres.Store, string, model.Principal) {
	t.Helper()
	db := isolatedStore(t)
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
	return db, id, actor
}
