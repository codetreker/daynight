package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type lifecycleThreadStore struct {
	*Store
	started  chan uint32
	acquired chan struct{}
	resume   <-chan struct{}
}

func (s *lifecycleThreadStore) WriteThread(ctx context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
	return s.Store.WriteThread(ctx, func(scope store.ThreadScope) error {
		s.started <- scope.(*ThreadTx).tx.Conn().PgConn().PID()
		return work(lifecycleThreadScope{ThreadScope: scope, acquired: s.acquired, resume: s.resume})
	})
}

type lifecycleThreadScope struct {
	store.ThreadScope
	acquired chan struct{}
	resume   <-chan struct{}
}

func (s lifecycleThreadScope) TaskDAO() store.ThreadTaskDAO {
	return lifecycleThreadTask{ThreadTaskDAO: s.ThreadScope.TaskDAO(), acquired: s.acquired, resume: s.resume}
}

type lifecycleThreadTask struct {
	store.ThreadTaskDAO
	acquired chan struct{}
	resume   <-chan struct{}
}

func (s lifecycleThreadTask) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	result, err := s.ThreadTaskDAO.LockTaskPresence(ctx, project, task)
	if err == nil && s.acquired != nil {
		close(s.acquired)
		select {
		case <-s.resume:
		case <-ctx.Done():
			return store.TaskPresence{}, ctx.Err()
		}
	}
	return result, err
}

type heldGoalLifecycle struct {
	*Store
	ready   chan struct{}
	release <-chan struct{}
}

func (s *heldGoalLifecycle) hold(ctx context.Context, err error) error {
	if err != nil {
		return err
	}
	close(s.ready)
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *heldGoalLifecycle) WriteProjectTransfer(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProjectTransfer(ctx, id, func(sc store.ProjectWriteScope) error { return s.hold(ctx, work(sc)) })
}
func (s *heldGoalLifecycle) WriteGitHubProjectTransfer(ctx context.Context, id string, work func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	return s.Store.WriteGitHubProjectTransfer(ctx, id, func(sc store.GitHubProjectTransferScope) error { return s.hold(ctx, work(sc)) })
}
func (s *heldGoalLifecycle) WriteProjectDeletion(ctx context.Context, id string, work func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return s.Store.WriteProjectDeletion(ctx, id, func(sc store.ProjectDeletionScope) error { return s.hold(ctx, work(sc)) })
}
func (s *heldGoalLifecycle) WriteGitHubProjectDeletion(ctx context.Context, id string, work func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	return s.Store.WriteGitHubProjectDeletion(ctx, id, func(sc store.GitHubProjectDeletionScope) error { return s.hold(ctx, work(sc)) })
}

func TestProjectLifecycleAndThreadGoalLockOrdering(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			for _, remote := range []bool{false, true} {
				for _, threadFirst := range []bool{false, true} {
					name := map[bool]string{true: "App", false: "base"}[app] + map[bool]string{true: "/delete", false: "/transfer"}[deleting] + map[bool]string{true: "/remote", false: "/source"}[remote] + map[bool]string{true: "/thread-first", false: "/lifecycle-first"}[threadFirst]
					t.Run(name, func(t *testing.T) {
						f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
						ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
						threadDone, lifecycleDone := make(chan error, 1), make(chan error, 1)
						threadLaunched, lifecycleLaunched, threadRead, lifecycleRead := false, false, false, false
						resumeThread, resumeLifecycle := make(chan struct{}), make(chan struct{})
						defer func() {
							cancel()
							select {
							case <-resumeThread:
							default:
								close(resumeThread)
							}
							select {
							case <-resumeLifecycle:
							default:
								close(resumeLifecycle)
							}
							cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
							defer stop()
							if threadLaunched && !threadRead {
								select {
								case <-threadDone:
								case <-cleanup.Done():
									t.Errorf("Thread cleanup: %v", cleanup.Err())
								}
							}
							if lifecycleLaunched && !lifecycleRead {
								select {
								case <-lifecycleDone:
								case <-cleanup.Done():
									t.Errorf("lifecycle cleanup: %v", cleanup.Err())
								}
							}
						}()
						local := uuid.NewString()
						mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','local downstream','todo')`, local, f.upProject.ID)
						mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, f.upProject.ID, local, f.up, uuid.NewString())
						// The creator retains access only through the source Team; moving to a
						// different owner's Team must make a late source Thread post fail.
						mustQueryExec(t, f.db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.upProject.ID, f.principal.UserID)
						_, destinationOwner, _ := testutil.AuthRecords(t, f.db)
						target, err := testutil.CreateTeam(ctx, f.db, destinationOwner.UserID, uuid.NewString(), "Destination")
						if err != nil {
							t.Fatal(err)
						}
						held := &heldGoalLifecycle{Store: f.db, ready: make(chan struct{}), release: resumeLifecycle}
						var svc goalProjectLifecycle = projectservice.NewProjects(held)
						if app {
							svc = projectservice.NewAppProjects(held)
						}
						preview, err := svc.TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
						if err != nil {
							t.Fatal(err)
						}
						input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true}
						project, goal := f.upProject.ID, local
						if remote {
							project, goal = f.downProject.ID, f.down
						}
						thread := &lifecycleThreadStore{Store: f.db, started: make(chan uint32, 1)}
						if threadFirst {
							thread.acquired = make(chan struct{})
							thread.resume = resumeThread
						}
						startThread := func() {
							threadLaunched = true
							go func() {
								_, err := taskservice.NewTaskThreads(thread).Post(ctx, f.principal, project, goal, taskservice.CreateThreadMessage{Body: "ordered post"})
								threadDone <- err
							}()
						}
						waitThreadStart := func() uint32 {
							t.Helper()
							select {
							case pid := <-thread.started:
								return pid
							case err := <-threadDone:
								threadRead = true
								t.Fatalf("Thread exited before starting transaction: %v", err)
							case <-ctx.Done():
								t.Fatal("Thread transaction did not start")
							}
							return 0
						}
						waitLifecycleReady := func() {
							t.Helper()
							select {
							case <-held.ready:
							case err := <-lifecycleDone:
								lifecycleRead = true
								t.Fatalf("lifecycle exited before commit barrier: %v", err)
							case <-ctx.Done():
								t.Fatal("lifecycle did not reach commit barrier")
							}
						}
						startLifecycle := func() {
							lifecycleLaunched = true
							go func() {
								var err error
								if deleting {
									_, err = svc.DeleteWithInput(ctx, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
								} else {
									_, err = svc.Transfer(ctx, f.principal, f.upProject.ID, input)
								}
								lifecycleDone <- err
							}()
						}
						if threadFirst {
							startThread()
							pid := waitThreadStart()
							select {
							case <-thread.acquired:
							case err := <-threadDone:
								threadRead = true
								t.Fatalf("Thread exited before Goal lock: %v", err)
							case <-ctx.Done():
								t.Fatal("Thread did not acquire Goal lock")
							}
							startLifecycle()
							waitTransferTeamLock(t, ctx, f.db, "WITH goals AS (SELECT id FROM tasks WHERE project_id=", pid)
							close(resumeThread)
							select {
							case err := <-threadDone:
								threadRead = true
								if err != nil {
									t.Fatalf("Thread could not authorize while lifecycle waits: %v", err)
								}
							case <-ctx.Done():
								t.Fatal("Thread blocked behind ownership")
							}
							waitLifecycleReady()
							close(resumeLifecycle)
						} else {
							startLifecycle()
							waitLifecycleReady()
							startThread()
							pid := waitThreadStart()
							waitThreadBackendLock(t, f.db, pid)
							close(resumeLifecycle)
						}
						if !lifecycleRead {
							select {
							case err := <-lifecycleDone:
								lifecycleRead = true
								if err != nil {
									t.Fatalf("lifecycle failed: %v", err)
								}
							case <-ctx.Done():
								t.Fatal("lifecycle did not finish")
							}
						}
						if !threadRead {
							select {
							case err := <-threadDone:
								threadRead = true
								if remote && err != nil {
									t.Fatalf("remote Thread failed after lifecycle: %v", err)
								}
								if !remote && err == nil {
									t.Fatal("source Thread used stale authorization")
								}
								if !remote && !deleting {
									var fault *model.Fault
									if !errors.As(err, &fault) || fault.Code != "forbidden" {
										t.Fatalf("lost authorization not observed: %v", err)
									}
								}
							case <-ctx.Done():
								t.Fatal("Thread did not finish")
							}
						}
						var messages int
						if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1 AND body='ordered post'`, goal).Scan(&messages); err != nil {
							t.Fatal(err)
						}
						expected := 1
						if !threadFirst && !remote {
							expected = 0
						}
						if messages != expected {
							t.Fatalf("messages=%d want %d", messages, expected)
						}
						assertGoalRelationState(t, f.db, f.down, 0, 2)
						testutil.AssertPoolReusable(t, f.db.Pool)
					})
				}
			}
		}
	}
}

func TestProjectLifecycleLocksAffectedTasksInUUIDOrder(t *testing.T) {
	for _, deleting := range []bool{false, true} {
		t.Run(map[bool]string{true: "deletion", false: "transfer"}[deleting], func(t *testing.T) {
			f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			done := make(chan error, 1)
			launched, drained := false, false
			low, high := queryID(30), queryID(40)
			lowProject, highProject := f.upProject.ID, f.downProject.ID
			if lowProject < highProject {
				lowProject, highProject = highProject, lowProject
			}
			for _, item := range []struct{ id, project string }{{low, lowProject}, {high, highProject}} {
				mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','ordered','todo')`, item.id, item.project)
				mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, item.project, item.id, f.up, uuid.NewString())
			}
			first, err := f.db.Pool.Begin(ctx)
			if err != nil {
				cancel()
				t.Fatal(err)
			}
			second, err := f.db.Pool.Begin(ctx)
			if err != nil {
				cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
				if cleanupErr := first.Rollback(cleanup); cleanupErr != nil && !errors.Is(cleanupErr, pgx.ErrTxClosed) {
					t.Errorf("first blocker cleanup: %v", cleanupErr)
				}
				stop()
				cancel()
				t.Fatal(err)
			}
			defer func() {
				cancel()
				cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
				defer stop()
				if err := first.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("first blocker cleanup: %v", err)
				}
				if err := second.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("second blocker cleanup: %v", err)
				}
				if launched && !drained {
					select {
					case <-done:
					case <-cleanup.Done():
						t.Errorf("lifecycle cleanup: %v", cleanup.Err())
					}
				}
			}()
			if _, err = first.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, low); err != nil {
				t.Fatal(err)
			}
			if _, err = second.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, high); err != nil {
				t.Fatal(err)
			}
			firstPID, secondPID := first.Conn().PgConn().PID(), second.Conn().PgConn().PID()
			launched = true
			go func() {
				var err error
				if deleting {
					_, err = f.db.WriteProjectDeletion(ctx, f.upProject.ID, func(store.ProjectDeletionScope) error { return nil })
				} else {
					_, err = f.db.WriteProjectTransfer(ctx, f.upProject.ID, func(store.ProjectWriteScope) error { return nil })
				}
				done <- err
			}()
			waitTransferTeamLock(t, ctx, f.db, "WITH goals AS (SELECT id FROM tasks WHERE project_id=", firstPID)
			if err = first.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			waitTransferTeamLock(t, ctx, f.db, "WITH goals AS (SELECT id FROM tasks WHERE project_id=", secondPID)
			if err = second.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				drained = true
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("lifecycle did not finish")
			}
			testutil.AssertPoolReusable(t, f.db.Pool)
		})
	}
}
