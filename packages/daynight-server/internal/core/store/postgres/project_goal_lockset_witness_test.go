package postgres

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type lifecycleLockWitness struct {
	*Store
	downstream string
	calls      atomic.Int32
}

func (s *lifecycleLockWitness) prove(ctx context.Context) error {
	s.calls.Add(1)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	_, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT`, s.downstream)
	var pgerr *pgconn.PgError
	if !errors.As(err, &pgerr) || pgerr.Code != "55P03" {
		return errors.New("downstream Project was not locked when callback began")
	}
	return nil
}
func (s *lifecycleLockWitness) WriteProjectTransfer(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProjectTransfer(ctx, id, func(scope store.ProjectWriteScope) error {
		if err := s.prove(ctx); err != nil {
			return err
		}
		return fn(scope)
	})
}
func (s *lifecycleLockWitness) WriteProjectDeletion(ctx context.Context, id string, fn func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return s.Store.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
		if err := s.prove(ctx); err != nil {
			return err
		}
		return fn(scope)
	})
}
func (s *lifecycleLockWitness) WriteGitHubProjectTransfer(ctx context.Context, id string, fn func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	return s.Store.WriteGitHubProjectTransfer(ctx, id, func(scope store.GitHubProjectTransferScope) error {
		if err := s.prove(ctx); err != nil {
			return err
		}
		return fn(scope)
	})
}
func (s *lifecycleLockWitness) WriteGitHubProjectDeletion(ctx context.Context, id string, fn func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	return s.Store.WriteGitHubProjectDeletion(ctx, id, func(scope store.GitHubProjectDeletionScope) error {
		if err := s.prove(ctx); err != nil {
			return err
		}
		return fn(scope)
	})
}

func TestProjectLifecycleRetriesNewDownstreamLockSet(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				extra, err := testutil.CreatePrivateProject(ctx, f.db, f.principal, uuid.NewString(), "New downstream", "https://example.test/new-downstream")
				if err != nil {
					t.Fatal(err)
				}
				goal := uuid.NewString()
				mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','new downstream','todo')`, goal, extra.ID)
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				witness := &lifecycleLockWitness{Store: f.db, downstream: extra.ID}
				var service goalProjectLifecycle = projectservice.NewProjects(witness)
				if app {
					service = projectservice.NewAppProjects(witness)
				}
				preview, err := service.TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true}
				tx, err := f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.WithoutCancel(ctx))
				if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, extra.ID); err != nil {
					t.Fatal(err)
				}
				if err = pg.LockGoalDependencyTeam(ctx, tx, extra.ID); err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					var e error
					if deleting {
						_, e = service.DeleteWithInput(ctx, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					} else {
						_, e = service.Transfer(ctx, f.principal, f.upProject.ID, input)
					}
					result <- e
				}()
				waitGoalAdvisoryWait(t, ctx, f.db)
				if witness.calls.Load() != 0 {
					t.Fatal("business callback ran before graph lock")
				}
				if _, err = tx.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, extra.ID, goal, f.up, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = testutil.ReceiveQueryResult(t, ctx, result); err != nil {
					t.Fatal(err)
				}
				if witness.calls.Load() != 1 {
					t.Fatalf("callback count %d", witness.calls.Load())
				}
				assertGoalRelationState(t, f.db, goal, 0, 2)
			})
		}
	}
}

func TestProjectLifecycleRefusesNonOwnerBeforeRemoteLocks(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				_, actor, _ := testutil.AuthRecords(t, f.db)
				mustQueryExec(t, f.db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.upProject.ID, actor.UserID)
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				preview, err := projectservice.NewProjects(f.db).TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: actor.UserID, ConfirmGoalDependencyRemoval: true}
				tx, err := f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.WithoutCancel(ctx))
				if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, f.downProject.ID); err != nil {
					t.Fatal(err)
				}
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				bounded, stop := context.WithTimeout(ctx, time.Second)
				defer stop()
				if deleting {
					_, err = service.DeleteWithInput(bounded, actor, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
				} else {
					_, err = service.Transfer(bounded, actor, f.upProject.ID, input)
				}
				assertGoalFault(t, err, "forbidden")
				assertGoalRelationState(t, f.db, f.down, 1, 1)
			})
		}
	}
}

func TestProjectLifecycleOverlappingLocksAvoidDeadlock(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	locked, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	first, second := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.db.WriteProjectTransfer(ctx, f.upProject.ID, func(store.ProjectWriteScope) error {
			close(locked)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		first <- err
	}()
	awaitGoalBarrier(t, ctx, locked, first)
	go func() {
		_, err := f.db.WriteProjectTransfer(ctx, f.downProject.ID, func(store.ProjectWriteScope) error { return nil })
		second <- err
	}()
	for {
		var waiting bool
		err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects WHERE id=$1%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if err = testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("second lifecycle did not reach Project lock: %v", err)
		}
	}
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, second); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}

func TestProjectLifecycleRemoteLockDeadlineRollsBack(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				preview, err := service.TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true}
				tx, err := f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.WithoutCancel(ctx))
				if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, f.downProject.ID); err != nil {
					t.Fatal(err)
				}
				bounded, stop := context.WithTimeout(ctx, 250*time.Millisecond)
				defer stop()
				if deleting {
					_, err = service.DeleteWithInput(bounded, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
				} else {
					_, err = service.Transfer(bounded, f.principal, f.upProject.ID, input)
				}
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("deadline lost: %v", err)
				}
				assertGoalRelationState(t, f.db, f.down, 1, 1)
				var deleted bool
				var owner string
				if err = f.db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,(SELECT team_id::text FROM project_ownership WHERE project_id=$1) FROM projects WHERE id=$1`, f.upProject.ID).Scan(&deleted, &owner); err != nil || deleted || owner != f.upProject.Ownership.TeamID {
					t.Fatalf("deadline changed project: deleted=%v owner=%s error=%v", deleted, owner, err)
				}
			})
		}
	}
}
