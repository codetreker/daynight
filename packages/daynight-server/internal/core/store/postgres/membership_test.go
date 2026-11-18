package postgres

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func membershipFixture(t *testing.T) (*Store, model.Principal, model.Principal, model.Project) {
	t.Helper()
	s := isolatedStore(t)
	admin, member, project := testutil.ProjectMembershipFixture(t, s)
	return s, admin, member, project
}

func newStoredInvitation(project model.Project, creator model.Principal, label string) model.ProjectInvitation {
	return testutil.ProjectInvitation(project, creator, label)
}

func TestMembershipStorageFailureRollsBackProjectCreation(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, admin, _, project := membershipFixture(t)
	ctx := t.Context()
	mustQueryExec(t, s, `CREATE FUNCTION reject_member() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test member rollback'; END $$;
		CREATE TRIGGER reject_member BEFORE INSERT ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_member()`)
	id := uuid.NewString()
	completion, err := s.WriteProjectCreation(ctx, admin.UserID, func(dao store.ProjectCreationDAO) error {
		_, _, err := dao.InsertProject(ctx, id, "Rollback", "https://example.com/rollback", project.Ownership.TeamID)
		return err
	})
	var databaseError *store.Error
	var cause *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &databaseError) || !errors.As(err, &cause) || cause.Code != "P0001" || cause.Message != "test member rollback" {
		t.Fatalf("initial administrator failure lost its rollback outcome or cause: %+v %v", completion, err)
	}
	var row, ownership, grant bool
	err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1),
		EXISTS(SELECT 1 FROM project_ownership WHERE project_id=$1),
		EXISTS(SELECT 1 FROM project_grants WHERE project_id=$1)`, id).Scan(&row, &ownership, &grant)
	if err != nil || row || ownership || grant {
		t.Fatalf("failed creation left project=%t ownership=%t grant=%t: %v", row, ownership, grant, err)
	}
	mustQueryExec(t, s, `DROP TRIGGER reject_member ON project_grants; DROP FUNCTION reject_member()`)
}

func TestMembershipStorageOperationalFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, _, _, project := membershipFixture(t)
	ctx := t.Context()
	s.Close()
	connection, closedPoolError := s.Pool.Acquire(ctx)
	if closedPoolError == nil {
		connection.Release()
		t.Fatal("closed pool allowed acquiring a connection")
	}
	completion, err := s.WriteProject(ctx, project.ID, func(store.ProjectWriteScope) error {
		t.Fatal("closed pool entered project write callback")
		return nil
	})
	var databaseError *store.Error
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &databaseError) || !errors.Is(err, closedPoolError) {
		t.Fatalf("closed project write pool lost its outcome or cause: %+v %v", completion, err)
	}
}
