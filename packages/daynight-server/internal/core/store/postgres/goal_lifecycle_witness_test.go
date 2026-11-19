package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type goalCommitBarrier struct {
	*Store
	prepared chan struct{}
	release  chan struct{}
}

func (s *goalCommitBarrier) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		if err := work(scope); err != nil {
			return err
		}
		close(s.prepared)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

type goalLifecycleFixture struct {
	db                     *Store
	principal              model.Principal
	upProject, downProject model.Project
	up, down               string
}

func newGoalLifecycleFixture(t *testing.T, upStatus, downStatus model.TaskStatus) goalLifecycleFixture {
	t.Helper()
	db, principal, _, upProject := membershipFixture(t)
	downProject, err := testutil.CreatePrivateProject(t.Context(), db, principal, uuid.NewString(), "Downstream", "https://example.test/goal-downstream")
	if err != nil {
		t.Fatal(err)
	}
	if upProject.Ownership.TeamID != downProject.Ownership.TeamID {
		t.Fatal("projects are not on the same Team")
	}
	up, down := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status,completed_at) VALUES
 ($1,$2,'goal','upstream',$3,CASE WHEN $3='done' THEN now() END),
 ($4,$5,'goal','downstream',$6,CASE WHEN $6='done' THEN now() END)`, up, upProject.ID, string(upStatus), down, downProject.ID, string(downStatus))
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, downProject.ID, down, up, uuid.NewString())
	return goalLifecycleFixture{db: db, principal: principal, upProject: upProject, downProject: downProject, up: up, down: down}
}

func awaitGoalBarrier(t *testing.T, ctx context.Context, acquired <-chan struct{}, result <-chan error) {
	t.Helper()
	select {
	case <-acquired:
	case err := <-result:
		t.Fatalf("first operation did not reach commit barrier: %v", err)
	case <-ctx.Done():
		t.Fatal("first operation did not reach commit barrier")
	}
}

func waitGoalAdvisoryWait(t *testing.T, ctx context.Context, db *Store) {
	t.Helper()
	for {
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("operation did not reach Team lock: %v", err)
		}
	}
}

func assertGoalFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || len(fault.TaskIDs) != 0 {
		t.Fatalf("wanted %s without remote IDs: %v", code, err)
	}
}

func TestGoalCompletionAndReopenSerializeAcrossProjects(t *testing.T) {
	for _, downFirst := range []bool{true, false} {
		name := "upstream_reopens_first"
		if downFirst {
			name = "downstream_completes_first"
		}
		t.Run(name, func(t *testing.T) {
			f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
			defer func() {
				select {
				case <-barrier.release:
				default:
					close(barrier.release)
				}
			}()
			firstService, secondService := taskservice.NewTasks(barrier), taskservice.NewTasks(f.db)
			firstProject, firstID, firstStatus := f.upProject.ID, f.up, model.TaskTodo
			secondProject, secondID, secondStatus := f.downProject.ID, f.down, model.TaskDone
			if downFirst {
				firstProject, firstID, firstStatus, secondProject, secondID, secondStatus = secondProject, secondID, secondStatus, firstProject, firstID, firstStatus
			}
			firstDone := make(chan error, 1)
			go func() {
				_, err := firstService.SetStatus(ctx, f.principal, firstProject, firstID, taskcore.SetTaskStatus{Version: 1, Status: firstStatus})
				firstDone <- err
			}()
			awaitGoalBarrier(t, ctx, barrier.prepared, firstDone)
			secondDone := make(chan error, 1)
			go func() {
				_, err := secondService.SetStatus(ctx, f.principal, secondProject, secondID, taskcore.SetTaskStatus{Version: 1, Status: secondStatus})
				secondDone <- err
			}()
			waitGoalAdvisoryWait(t, ctx, f.db)
			close(barrier.release)
			if err := testutil.ReceiveQueryResult(t, ctx, firstDone); err != nil {
				t.Fatalf("first operation: %v", err)
			}
			err := testutil.ReceiveQueryResult(t, ctx, secondDone)
			if downFirst {
				assertGoalFault(t, err, "goal_dependency_done_successor")
			} else {
				assertGoalFault(t, err, "goal_dependency_unsatisfied")
			}
			up := snapshotTask(t, f.db, f.upProject.ID, f.up)
			down := snapshotTask(t, f.db, f.downProject.ID, f.down)
			if downFirst {
				if up.Status != model.TaskDone || up.Version != 1 || down.Status != model.TaskDone || down.Version != 2 {
					t.Fatalf("completion-first readback: up=%+v down=%+v", up, down)
				}
			} else if up.Status != model.TaskTodo || up.Version != 2 || down.Status != model.TaskTodo || down.Version != 1 {
				t.Fatalf("reopen-first readback: up=%+v down=%+v", up, down)
			}
		})
	}
}

func TestGoalDifferentTeamsDoNotShareGraphLock(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	team, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Independent Team")
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := testutil.CreateProjectInTeam(ctx, f.db, f.principal, uuid.NewString(), "Independent", "https://example.test/other-team", &team.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherGoal := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','independent','todo')`, otherGoal, other.ID)
	barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-barrier.release:
		default:
			close(barrier.release)
		}
	}()
	first := make(chan error, 1)
	go func() {
		_, err := taskservice.NewTasks(barrier).SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
		first <- err
	}()
	awaitGoalBarrier(t, ctx, barrier.prepared, first)
	independent, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	got, err := taskservice.NewTasks(f.db).SetStatus(independent, f.principal, other.ID, otherGoal, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
	if err != nil || got.Status != model.TaskDone {
		t.Fatalf("independent Team blocked: %+v %v", got, err)
	}
	close(barrier.release)
	if err := testutil.ReceiveQueryResult(t, ctx, first); err != nil {
		t.Fatal(err)
	}
}

func TestGoalDeleteProtectsIncomingAndRetainsRevision(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	ctx := t.Context()
	tasks := taskservice.NewTasks(f.db)
	before := snapshotTask(t, f.db, f.upProject.ID, f.up)
	err := tasks.Delete(ctx, f.principal, f.upProject.ID, f.up, taskcore.DeleteTask{Version: before.Version})
	assertGoalFault(t, err, "goal_dependency_referenced")
	if got := snapshotTask(t, f.db, f.upProject.ID, f.up); got.Version != before.Version || got.Status != before.Status {
		t.Fatalf("rejected deletion changed Goal: %+v", got)
	}
	mustQueryExec(t, f.db, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3 AND dependency_type='goal'`, f.downProject.ID, f.down, f.up)
	mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, f.upProject.ID, f.up, f.down, uuid.NewString())
	mustQueryExec(t, f.db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,7)`, f.up)
	if err := tasks.Delete(ctx, f.principal, f.upProject.ID, f.up, taskcore.DeleteTask{Version: before.Version}); err != nil {
		t.Fatal(err)
	}
	var deleted bool
	var outgoing int
	var revision int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT deleted_at IS NOT NULL FROM tasks WHERE id=$1), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal'), (SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1)`, f.up).Scan(&deleted, &outgoing, &revision); err != nil || !deleted || outgoing != 0 || revision != 8 {
		t.Fatalf("delete readback deleted=%v outgoing=%d revision=%d error=%v", deleted, outgoing, revision, err)
	}
}

func TestGoalTeamLockTimeoutReleasesProjectAndConnection(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		completion, err := f.db.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
			if err := scope.GoalDependencyDAO().LockTeam(ctx); err != nil {
				return err
			}
			close(acquired)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = errors.New("holder transaction not committed")
		}
		stopped <- err
	}()
	awaitGoalBarrier(t, ctx, acquired, stopped)
	tasks := taskservice.NewTasks(f.db)
	result := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := tasks.SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
		result <- err
	}()
	waitGoalAdvisoryWait(t, ctx, f.db)
	err := testutil.ReceiveQueryResult(t, ctx, result)
	if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil || time.Since(started) < 4*time.Second || time.Since(started) > 8*time.Second {
		t.Fatalf("Goal did not actively time out under held Team lock: elapsed=%v caller=%v error=%v", time.Since(started), ctx.Err(), err)
	}
	if got := snapshotTask(t, f.db, f.downProject.ID, f.down); got.Status != model.TaskTodo || got.Version != 1 {
		t.Fatalf("timed-out Goal changed: %+v", got)
	}
	ordinary := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','unrelated','todo')`, ordinary, f.downProject.ID)
	changed, err := tasks.SetStatus(ctx, f.principal, f.downProject.ID, ordinary, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress})
	if err != nil || changed.Status != model.TaskInProgress {
		t.Fatalf("ordinary Task could not acquire released Project lock: %+v %v", changed, err)
	}
	if acquired := f.db.Pool.Stat().AcquiredConns(); acquired != 1 {
		t.Fatalf("timed-out waiter retained a connection: %d acquired, want only holder", acquired)
	}
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}

// Revoking the only access source while a Goal write waits must take effect
// before the waiting transaction evaluates or changes the Goal.
func TestGoalLifecycleRechecksAuthorizationAfterTeamLockWait(t *testing.T) {
	for _, operation := range []string{"status", "delete"} {
		t.Run(operation, func(t *testing.T) {
			db, admin, _, _ := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, member, _ := testutil.AuthRecords(t, db)
			team, err := testutil.CreateTeam(ctx, db, admin.UserID, uuid.NewString(), "Revocation Team")
			if err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID)
			project, _, err := testutil.CreateProjectInTeam(ctx, db, admin, uuid.NewString(), "Target", "https://example.test/goal-revocation-target", &team.ID)
			if err != nil {
				t.Fatal(err)
			}
			holderProject, _, err := testutil.CreateProjectInTeam(ctx, db, admin, uuid.NewString(), "Holder", "https://example.test/goal-revocation-holder", &team.ID)
			if err != nil {
				t.Fatal(err)
			}
			goal := uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','protected','todo')`, goal, project.ID)
			var membershipVersion int64
			var directGrant bool
			if err := db.Pool.QueryRow(ctx, `SELECT m.version, EXISTS(SELECT 1 FROM project_grants WHERE project_id=$3 AND user_id=$2) FROM team_members m WHERE m.team_id=$1 AND m.user_id=$2`, team.ID, member.UserID, project.ID).Scan(&membershipVersion, &directGrant); err != nil || directGrant {
				t.Fatalf("member did not have Team-only access: direct=%v error=%v", directGrant, err)
			}
			before := snapshotTask(t, db, project.ID, goal)
			acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			go func() {
				completion, err := db.WriteProject(ctx, holderProject.ID, func(scope store.ProjectWriteScope) error {
					if err := scope.GoalDependencyDAO().LockTeam(ctx); err != nil {
						return err
					}
					close(acquired)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = errors.New("holder transaction not committed")
				}
				stopped <- err
			}()
			awaitGoalBarrier(t, ctx, acquired, stopped)
			result := make(chan error, 1)
			go func() {
				tasks := taskservice.NewTasks(db)
				if operation == "delete" {
					result <- tasks.Delete(ctx, member, project.ID, goal, taskcore.DeleteTask{Version: before.Version})
					return
				}
				_, err := tasks.SetStatus(ctx, member, project.ID, goal, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskDone})
				result <- err
			}()
			waitGoalAdvisoryWait(t, ctx, db)
			_, err = teamservice.NewTeams(db).RemoveMember(ctx, admin, team.ID, member.UserID, teamcore.ChangeTeamMember{Version: membershipVersion, ExpectedUserID: admin.UserID})
			if err != nil {
				t.Fatalf("remove Team membership during lock wait: %v", err)
			}
			close(release)
			if err := testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
				t.Fatal(err)
			}
			assertGoalFault(t, testutil.ReceiveQueryResult(t, ctx, result), "not_found")
			after := snapshotTask(t, db, project.ID, goal)
			if after.Status != before.Status || after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) || after.CompletedAt != nil {
				t.Fatalf("revoked %s changed Goal: before=%+v after=%+v", operation, before, after)
			}
		})
	}
}

// Hold the only connection after the real type snapshot has ended, before the
// service can begin its write. The snapshot itself keeps the caller's context.
type goalPoolAdmissionBarrier struct {
	*Store
	ready           chan struct{}
	held            *pgxpool.Conn
	snapshotContext context.Context
}

func (s *goalPoolAdmissionBarrier) ReadSnapshot(ctx context.Context, work func(store.SnapshotScope) error) error {
	s.snapshotContext = ctx
	if err := s.Store.ReadSnapshot(ctx, work); err != nil {
		return err
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	s.held = conn
	close(s.ready)
	return nil
}

func TestGoalWritePoolWaitHasBranchDeadline(t *testing.T) {
	for _, operation := range []string{"status", "delete"} {
		t.Run(operation, func(t *testing.T) {
			f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			config := f.db.Pool.Config()
			config.MaxConns, config.MinConns = 1, 0
			pool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			barrier := &goalPoolAdmissionBarrier{Store: &Store{Pool: pool}, ready: make(chan struct{})}
			result := make(chan error, 1)
			go func() {
				tasks := taskservice.NewTasks(barrier)
				if operation == "delete" {
					result <- tasks.Delete(ctx, f.principal, f.downProject.ID, f.down, taskcore.DeleteTask{Version: 1})
					return
				}
				_, err := tasks.SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
				result <- err
			}()
			select {
			case <-barrier.ready:
			case err := <-result:
				t.Fatalf("preflight did not complete before write: %v", err)
			case <-ctx.Done():
				t.Fatal("preflight did not complete")
			}
			defer barrier.held.Release()
			if barrier.snapshotContext != ctx {
				t.Fatal("type preflight did not retain caller context")
			}
			started := time.Now()
			beforeCanceled := pool.Stat().CanceledAcquireCount()
			err = testutil.ReceiveQueryResult(t, ctx, result)
			elapsed := time.Since(started)
			if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil || elapsed < 4*time.Second || elapsed > 8*time.Second {
				t.Fatalf("write did not time out while waiting for pool: elapsed=%v caller=%v error=%v", elapsed, ctx.Err(), err)
			}
			if stat := pool.Stat(); stat.CanceledAcquireCount() != beforeCanceled+1 || stat.AcquiredConns() != 1 {
				t.Fatalf("pool did not cancel its blocked write acquisition: canceled=%d acquired=%d", stat.CanceledAcquireCount(), stat.AcquiredConns())
			}
			goal := snapshotTask(t, f.db, f.downProject.ID, f.down)
			if goal.Status != model.TaskTodo || goal.Version != 1 {
				t.Fatalf("pool timeout changed Goal: %+v", goal)
			}
			barrier.held.Release()
			testutil.AssertPoolReusable(t, pool)
		})
	}
}
