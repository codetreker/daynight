package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestProjectMembersAndActorAccessShareSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, actor, _, project := membershipFixture(t)
	ctx := t.Context()
	team := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'Snapshot owner')`, team)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, team)
	mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, actor.UserID)
	mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1`, project.ID)
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		access, err := scope.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, actor.UserID)
		members, err := scope.ProjectDAO().ProjectParticipants(ctx, project.ID)
		if err != nil {
			return err
		}
		if access.Role != model.ProjectAdmin || !access.CanTransfer || access.DirectGrant != nil || access.TeamRole == nil || *access.TeamRole != model.ProjectAdmin || len(members) != 1 || members[0].EffectiveRole != model.ProjectAdmin || members[0].InheritedFrom == nil || members[0].InheritedFrom.Role != model.ProjectAdmin {
			return fmt.Errorf("mixed member/actor snapshot: access=%+v members=%+v", access, members)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		access, err := scope.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil {
			return err
		}
		if access.Role != model.ProjectMemberRole || access.CanTransfer {
			return fmt.Errorf("fresh snapshot missed role downgrade: %+v", access)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectOwnershipAndAccessShareSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, actor, _, project := membershipFixture(t)
	ctx := t.Context()
	team := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'New owner')`, team)
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		before, err := scope.ProjectDAO().Project(ctx, project.ID)
		if err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=9007199254740993 WHERE project_id=$1`, project.ID, team)
		access, err := scope.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil {
			return err
		}
		if before.Ownership != project.Ownership || access.Ownership != before.Ownership || access.OwnerTeam.ID != project.Ownership.TeamID || access.OwnerTeam.Kind != "personal" {
			return fmt.Errorf("mixed Project/access snapshot: project=%+v access=%+v", before, access)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		after, err := scope.ProjectDAO().Project(ctx, project.ID)
		if err != nil {
			return err
		}
		access, err := scope.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil {
			return err
		}
		if after.Ownership.TeamID != team || after.Ownership.Version != 9007199254740993 || access.OwnerTeam.ID != team || access.OwnerTeam.Kind != "ordinary" || access.TeamRole != nil || access.CanTransfer || access.DirectGrant == nil {
			return fmt.Errorf("fresh snapshot missed ownership change: project=%+v access=%+v", after, access)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestOrdinaryTaskWriteDoesNotFenceOwnershipSources(t *testing.T) {
	database, actor, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID)
	task := queryTask(t, database, project.ID, 91, model.TaskTodo)
	blocker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	var id string
	if err := blocker.QueryRow(ctx, `SELECT id::text FROM tasks WHERE id=$1 FOR UPDATE`, task.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	result, done := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(done)
		_, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
			if _, err := scope.ProjectDAO().ProjectAccess(ctx, actor); err != nil {
				return err
			}
			current, err := scope.TaskDAO().Task(ctx, task.ID)
			if err != nil {
				return err
			}
			values := taskMutationValues(current)
			values.Title = "Admitted task write"
			_, err = scope.TaskDAO().UpdateTask(ctx, task.ID, values)
			return err
		})
		result <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("ordinary Task writer did not drain")
		}
	})
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("Task writer did not reach its real row-lock wait: %v", err)
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	sources, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer sources.Rollback(context.Background())
	var team string
	if err := sources.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE NOWAIT`, project.ID).Scan(&team); err != nil {
		t.Fatal("ordinary Task admission retained an ownership source lock", err)
	}
	if err := sources.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE NOWAIT`, team, actor.UserID).Scan(&id); err != nil {
		t.Fatal("ordinary Task admission retained a Team member source lock", err)
	}
	if err := sources.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	changed := snapshotTask(t, database, project.ID, task.ID)
	if changed.Title != "Admitted task write" || changed.Version != task.Version+1 {
		t.Fatalf("ordinary admitted Task write: %+v", changed)
	}
	var grants int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID).Scan(&grants); err != nil || grants != 0 {
		t.Fatalf("inherited Task write recreated its removed direct grant: %d %v", grants, err)
	}
}
