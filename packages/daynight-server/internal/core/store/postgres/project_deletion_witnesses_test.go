package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func waitProjectDeletionWitnessBlock(t *testing.T, ctx context.Context, database *Store, blocker uint32) uint32 {
	t.Helper()
	for {
		var pid uint32
		err := database.Pool.QueryRow(ctx, `SELECT coalesce((SELECT pid FROM pg_stat_activity
 WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, blocker).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("no observed waiter for backend %d: %v", blocker, err)
		}
	}
}

func TestProjectDeletionOrdersClaimAndThread(t *testing.T) {
	for _, operation := range []string{"claim", "thread"} {
		for _, deletionFirst := range []bool{false, true} {
			for _, taskDeleted := range []bool{false, true} {
				if taskDeleted && (operation != "thread" || !deletionFirst) {
					continue
				}
				t.Run(fmt.Sprintf("%s/deletion-first=%t/deleted-task=%t", operation, deletionFirst, taskDeleted), func(t *testing.T) {
					database, principal, _, project := membershipFixture(t)
					task := queryTask(t, database, project.ID, 10, model.TaskTodo)
					if taskDeleted {
						mustQueryExec(t, database, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID)
					}
					ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
					defer cancel()
					target := `BEFORE UPDATE OF deleted_at ON projects`
					if !deletionFirst && operation == "claim" {
						target = `BEFORE INSERT ON task_properties`
					} else if !deletionFirst {
						target = `BEFORE INSERT ON task_thread_messages`
					}
					mustQueryExec(t, database, `CREATE FUNCTION block_project_deletion_witness() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM pg_advisory_xact_lock(13629020); RETURN NEW; END $$;
 CREATE TRIGGER block_project_deletion_witness `+target+` FOR EACH ROW EXECUTE FUNCTION block_project_deletion_witness()`)
					locker, err := database.Pool.Acquire(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer locker.Release()
					if _, err := locker.Exec(ctx, `SELECT pg_advisory_lock(13629020)`); err != nil {
						t.Fatal(err)
					}
					defer locker.Exec(context.Background(), `SELECT pg_advisory_unlock(13629020)`)
					activeClaim := errors.New("fresh deletion scope observed active worker claim")
					mutation, deletion := make(chan error, 1), make(chan error, 1)
					startMutation := func() {
						go func() {
							if operation == "thread" {
								_, _, err := threadWitnessAppend(ctx, database, principal, project.ID, task.ID, "retained message", nil)
								mutation <- err
								return
							}
							_, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
								current, err := scope.TaskDAO().Task(ctx, task.ID)
								if err != nil {
									return err
								}
								claim := &model.WorkerClaim{ClaimID: uuid.NewString(), UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: current.CreatedAt}
								_, err = scope.TaskDAO().UpdateTask(ctx, task.ID, store.TaskWrite{Title: current.Title, Description: current.Description, AssignedTo: current.AssignedTo,
									RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents, Status: model.TaskInProgress,
									DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn, Properties: fixtureTaskProperties(t, claim)})
								return err
							})
							mutation <- err
						}()
					}
					startDeletion := func() {
						go func() {
							_, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
								if _, err := scope.ProjectDAO().Authorization(ctx, principal); err != nil {
									return err
								}
								if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
									if item.Worker != nil && item.Worker.State == model.WorkerActive {
										return activeClaim
									}
									return nil
								}); err != nil {
									return err
								}
								marked, err := scope.ProjectDAO().MarkDeleted(ctx)
								if err == nil && !marked {
									return errors.New("locked live Project was not marked")
								}
								return err
							})
							deletion <- err
						}()
					}
					if deletionFirst {
						startDeletion()
					} else {
						startMutation()
					}
					firstPID := waitProjectDeletionWitnessBlock(t, ctx, database, locker.Conn().PgConn().PID())
					if deletionFirst {
						startMutation()
					} else {
						startDeletion()
					}
					waitProjectDeletionWitnessBlock(t, ctx, database, firstPID)
					if _, err := locker.Exec(ctx, `SELECT pg_advisory_unlock(13629020)`); err != nil {
						t.Fatal(err)
					}
					mutationErr := receiveQueryResult(t, ctx, mutation)
					deletionErr := receiveQueryResult(t, ctx, deletion)
					if deletionFirst {
						if deletionErr != nil || !errors.Is(mutationErr, model.ErrNotFound) {
							t.Fatalf("deletion did not exclude later mutation: deletion=%v mutation=%v", deletionErr, mutationErr)
						}
					} else if operation == "claim" {
						if mutationErr != nil || !errors.Is(deletionErr, activeClaim) {
							t.Fatalf("deletion missed fresh claim: mutation=%v deletion=%v", mutationErr, deletionErr)
						}
					} else if mutationErr != nil || deletionErr != nil {
						t.Fatalf("thread lock direction prevented completion: mutation=%v deletion=%v", mutationErr, deletionErr)
					}
					if operation == "thread" {
						var count int
						want := 1
						if deletionFirst {
							want = 0
						}
						if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != want {
							t.Fatalf("retained thread count=%d want=%d: %v", count, want, err)
						}
					} else {
						var version int64
						var worker bool
						want := task.Version + 1
						if deletionFirst {
							want = task.Version
						}
						if err := database.Pool.QueryRow(ctx, `SELECT version,EXISTS(SELECT 1 FROM task_properties WHERE task_id=$1 AND name='worker') FROM tasks WHERE id=$1`, task.ID).Scan(&version, &worker); err != nil || worker == deletionFirst || version != want {
							t.Fatalf("claim escaped transaction order: version=%d worker=%v error=%v", version, worker, err)
						}
					}
				})
			}
		}
	}
}

func TestProjectDeletionWaitingStatementUsesOldProjectSnapshot(t *testing.T) {
	database, _, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	for _, sql := range []string{`SELECT id FROM projects WHERE id=$1 FOR UPDATE`, `SELECT id FROM tasks WHERE project_id=$1 FOR UPDATE`, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`} {
		if _, err := deletion.Exec(ctx, sql, project.ID); err != nil {
			t.Fatal(err)
		}
	}
	waiter, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Rollback(context.Background())
	result := make(chan error, 1)
	go func() {
		var selected bool
		err := waiter.QueryRow(ctx, `SELECT p.deleted_at IS NULL FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.deleted_at IS NULL FOR SHARE OF t`, task.ID).Scan(&selected)
		if err == nil && !selected {
			err = errors.New("waiting statement missed the original live Project snapshot")
		}
		result <- err
	}()
	waitProjectDeletionWitnessBlock(t, ctx, database, deletion.Conn().PgConn().PID())
	if err := deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatalf("waiting statement: %v", err)
	}
	var live bool
	if err := waiter.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, project.ID).Scan(&live); err != nil || live {
		t.Fatalf("fresh statement retained old Project: live=%v error=%v", live, err)
	}
}

func TestProjectDeletionAuthorizationAfterTransferAndReturn(t *testing.T) {
	database, original, other, project := membershipFixture(t)
	ctx := t.Context()
	target, err := testCreateTeam(database, ctx, other.UserID, uuid.NewString(), "Destination")
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID)
	reference := setSnapshotTaskClaim(t, database, project.ID, 10, original.UserID, uuid.NewString())
	check := func(actor model.Principal, transferable bool) {
		t.Helper()
		completion, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
			access, err := scope.ProjectDAO().Authorization(ctx, actor)
			if err != nil || access.CanTransfer != transferable {
				return fmt.Errorf("fresh deletion authorization: access=%#v transferable=%t error=%w", access, transferable, err)
			}
			count := 0
			if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
				count++
				if item.TaskID != reference.TaskID || item.Worker == nil || item.Worker.ClaimID != reference.ClaimID || item.Worker.State != model.WorkerActive {
					return fmt.Errorf("fresh worker observation: %#v", item)
				}
				return nil
			}); err != nil {
				return err
			}
			if count != 1 {
				return fmt.Errorf("worker count=%d", count)
			}
			return nil
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("locked observations: %#v %v", completion, err)
		}
	}
	check(original, true)
	check(other, false)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, project.ID, target.ID)
	check(original, false)
	check(other, true)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, project.ID, project.Ownership.TeamID)
	check(other, false)
	check(original, true)
	mustQueryExec(t, database, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, reference.TaskID)
	completion, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(store.ProjectDeletionWorker) error { return errors.New("released worker remained visible") }); err != nil {
			return err
		}
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err == nil && !marked {
			return errors.New("Project not marked after worker release")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion after release: %#v %v", completion, err)
	}
}
