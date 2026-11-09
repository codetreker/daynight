package postgres

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
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
	s, admin, _, _ := membershipFixture(t)
	ctx := context.Background()
	if _, err := s.Pool.Exec(ctx, `CREATE FUNCTION reject_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test member rollback'; END $$; CREATE TRIGGER reject_member BEFORE INSERT ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_member()`); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err := s.CreatePrivateProject(ctx, admin, id, "Rollback", "https://example.com/rollback"); err == nil {
		t.Fatal("membership failure accepted")
	}
	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)`, id).Scan(&exists); err != nil || exists {
		t.Fatalf("half project remained: %t %v", exists, err)
	}
	if _, err := s.Pool.Exec(ctx, `DROP TRIGGER reject_member ON project_grants; DROP FUNCTION reject_member()`); err != nil {
		t.Fatal(err)
	}

}

func TestMembershipStorageOperationalFailures(t *testing.T) {
	s, admin, _, _ := membershipFixture(t)
	s.Close()
	if _, err := s.CreatePrivateProject(context.Background(), admin, uuid.NewString(), "Closed", "https://example.com/closed"); err == nil {
		t.Fatal("closed pool accepted")
	}
}
