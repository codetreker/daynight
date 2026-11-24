package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func waitForQueryLock(t *testing.T, s *Store, prefix string) {
	t.Helper()
	testutil.WaitForQueryLock(t, s.Pool, prefix)
}

func receiveQueryResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	return testutil.ReceiveQueryResult(t, ctx, result)
}

func TestProjectTransactionsSerializeAndReadFreshAfterLock(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	first, second := queryProject(t, s, 1), queryProject(t, s, 2)
	task := queryTask(t, s, first.ID, 11, model.TaskTodo)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan error, 1)
	var firstUpdate, secondUpdate model.Task
	if err := writeProjectForTest(s, ctx, first.ID, func(tx ProjectWriteScope) error {
		var isolation string
		if err := tx.(*ProjectTx).tx.QueryRow(ctx, "SHOW transaction_isolation").Scan(&isolation); err != nil || isolation != "read committed" {
			t.Fatalf("write isolation: %s, %v", isolation, err)
		}
		go func() {
			result <- writeProjectForTest(s, ctx, first.ID, func(waiter ProjectWriteScope) error {
				fresh, err := waiter.TaskDAO().Task(ctx, task.ID)
				if err != nil {
					return err
				}
				if fresh.Status != model.TaskDone || fresh.Version != 2 {
					return errors.New("lock waiter read a snapshot predating the preceding commit")
				}
				secondUpdate, err = waiter.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Second", Status: model.TaskDone})
				return err
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		independent, finish := context.WithTimeout(ctx, 2*time.Second)
		defer finish()
		if err := writeProjectForTest(s, independent, second.ID, func(other ProjectWriteScope) error {
			_, err := other.TaskDAO().CreateTask(independent, queryID(12), TaskWrite{Title: "Independent", Status: model.TaskTodo})
			return err
		}); err != nil {
			t.Fatalf("unrelated project was blocked: %v", err)
		}
		var err error
		firstUpdate, err = tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "First", Status: model.TaskDone})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	if secondUpdate.Version != 3 || !secondUpdate.UpdatedAt.After(firstUpdate.UpdatedAt) {
		t.Fatalf("lock waiter timestamp/version regressed: first %#v, second %#v", firstUpdate, secondUpdate)
	}
}

func TestProjectTransactionsCancelActualRowLockWithoutLateWrite(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	before := queryTask(t, s, project.ID, 11, model.TaskTodo)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	var invoked atomic.Bool
	if err := writeProjectForTest(s, ctx, project.ID, func(ProjectWriteScope) error {
		waiting, cancel := context.WithCancel(ctx)
		defer cancel()
		result := make(chan error, 1)
		go func() {
			result <- writeProjectForTest(s, waiting, project.ID, func(tx ProjectWriteScope) error {
				invoked.Store(true)
				_, err := tx.TaskDAO().UpdateTask(waiting, before.ID, TaskWrite{Title: "Late", Status: model.TaskDone})
				return err
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		cancel()
		if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
			t.Fatalf("row-lock cancellation cause: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if invoked.Load() {
		t.Fatal("canceled lock wait invoked mutation callback")
	}
	after := snapshotTask(t, s, project.ID, before.ID)
	if after.Title != before.Title || after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("canceled row-lock wait wrote late: %#v", after)
	}
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().Task(ctx, before.ID)
		return err
	}); err != nil {
		t.Fatalf("lock was not reusable: %v", err)
	}
}

func TestProjectTransactionsCancelActualQueryWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, "LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- s.ReadSnapshot(waiting, func(snapshot SnapshotScope) error {
			_, err := snapshot.TaskDAO().Task(waiting, project.ID, task.ID)
			return err
		})
	}()
	waitForQueryLock(t, s, "SELECT t.id::text")
	cancel()
	if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("query cancellation cause: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if after := snapshotTask(t, s, project.ID, task.ID); after.Version != task.Version {
		t.Fatalf("canceled query changed task: %#v", after)
	}
	assertMigrationPoolReusable(t, s.Pool)
}

func TestQueriesFailuresPreserveCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	for _, operation := range []func() error{
		func() error { _, err := s.CreateProject(canceled, queryID(99), "Canceled", "repo"); return err },
		func() error {
			return s.ReadSnapshot(canceled, func(SnapshotScope) error { t.Fatal("canceled snapshot began"); return nil })
		},
		func() error {
			return writeProjectForTest(s, canceled, project.ID, func(ProjectWriteScope) error { t.Fatal("canceled writer began"); return nil })
		},
	} {
		if err := operation(); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled begin cause: %v", err)
		}
	}
	var expiredSnapshot SnapshotScope
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error { expiredSnapshot = snapshot; return nil }); err != nil {
		t.Fatal(err)
	}
	var expiredProject ProjectWriteScope
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error { expiredProject = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := expiredSnapshot.ProjectDAO().Projects(ctx, Page{Limit: 10}); return err },
		func() error { _, err := expiredSnapshot.ObservedAt(ctx); return err },
		func() error {
			_, err := expiredSnapshot.TaskDAO().Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
			return err
		},
		func() error { _, err := expiredProject.TaskDAO().TasksByID(ctx, []string{task.ID}); return err },
		func() error { _, err := expiredProject.TaskDAO().ActiveDependentIDs(ctx, task.ID); return err },
		func() error { _, err := expiredProject.ProjectDAO().Project(ctx); return err },
		func() error { _, err := expiredProject.ProjectDAO().UpdateProjectSettings(ctx, 90); return err },
		func() error {
			_, err := expiredProject.TaskDAO().Reachable(ctx, task.ID, queryID(99), DependencyReplacement{TaskID: task.ID, DependsOn: nil})
			return err
		},
	} {
		if err := operation(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("completed transaction cause was lost: %v", err)
		}
	}
	for _, test := range []struct {
		name string
		call func(ProjectWriteScope) error
	}{
		{"invalid task metadata", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "", Status: model.TaskTodo})
			return err
		}},
		{"invalid update", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: "unknown"})
			return err
		}},
		{"invalid edge rolls back creation", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "New", Status: model.TaskTodo, DependsOn: []string{queryID(12)}})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := writeProjectForTest(s, ctx, project.ID, test.call); err == nil {
				t.Fatal("invalid database write succeeded")
			}
			if got := snapshotTask(t, s, project.ID, task.ID); got.Title != task.Title || got.Version != task.Version {
				t.Fatalf("failed update changed task: %#v", got)
			}
		})
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TaskDAO().Task(ctx, project.ID, queryID(12))
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("failed create was persisted: %v", err)
	}

	dependency := queryTask(t, s, project.ID, 13, model.TaskDone)
	queryTask(t, s, project.ID, 14, model.TaskTodo, dependency.ID)
	mustQueryExec(t, s, `CREATE FUNCTION reject_edge_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'private SQL diagnostic'; END $$;
		CREATE TRIGGER reject_edge_delete BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_edge_delete()`)
	err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, queryID(14), TaskWrite{Title: "Changed", Status: model.TaskTodo})
		return err
	})
	if err == nil || strings.Contains(err.Error(), "private SQL") {
		t.Fatalf("replace dependency error: %v", err)
	}
}

func TestProjectWriteScopeCompletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 91)
	before := queryTask(t, s, project.ID, 92, model.TaskTodo)
	rejected := errors.New("reject project mutation")
	completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		current, err := scope.TaskDAO().Task(ctx, before.ID)
		if err != nil {
			return err
		}
		if _, err := scope.TaskDAO().UpdateTask(ctx, current.ID, TaskWrite{Title: "Rolled back", Status: current.Status}); err != nil {
			return err
		}
		return rejected
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, rejected) {
		t.Fatalf("failed operation completion = %q, err = %v", completion.Outcome, err)
	}
	if after := snapshotTask(t, s, project.ID, before.ID); after.Title != before.Title || after.Version != before.Version {
		t.Fatalf("failed operation persisted: %#v", after)
	}
	completion, err = s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.ProjectDAO().Project(ctx)
		return err
	})
	if completion.Outcome != TransactionCommitted || err != nil {
		t.Fatalf("successful operation completion = %q, err = %v", completion.Outcome, err)
	}
}

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
	parallelRootDatabaseTest(t)
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

func TestProjectWorkerClaimAdmissionSharesTransactionAndCompletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	ctx := t.Context()
	rejected := errors.New("reject project operation")
	for index, commit := range []bool{false, true} {
		user, id := queryID(10+index*2), queryID(11+index*2)
		var retained WorkerClaimAdmissionDAO
		completion, err := db.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
			tx := scope.(*ProjectTx).tx
			if _, err := tx.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,statement_timestamp(),statement_timestamp(),'{}','{}',19,statement_timestamp(),'{"only":"uncommitted"}')`, user, id); err != nil {
				return err
			}
			retained = scope.WorkerClaimAdmissionDAO()
			got, err := retained.ClaimWorkerConfiguration(ctx, user, id)
			if err != nil {
				return err
			}
			if got == nil || got.Revision != "19" || string(got.Raw) != `{"only": "uncommitted"}` {
				t.Fatalf("accessor failed to read enclosing transaction's uncommitted row: %+v", got)
			}
			if commit {
				return nil
			}
			return rejected
		})
		expected := TransactionNotCommitted
		if commit {
			expected = TransactionCommitted
		}
		if completion.Outcome != expected || (commit && err != nil) || (!commit && !errors.Is(err, rejected)) {
			t.Fatalf("completion: %+v %v", completion, err)
		}
		var exists bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workers WHERE user_id=$1 AND worker_id=$2)`, user, id).Scan(&exists); err != nil || exists != commit {
			t.Fatalf("enclosing transaction persistence: %v %v", exists, err)
		}
		if got, err := retained.ClaimWorkerConfiguration(context.Background(), user, id); got != nil || !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("capability escaped transaction lifetime: %+v %v", got, err)
		}
	}
}
