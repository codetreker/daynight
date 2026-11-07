package task_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/jackc/pgx/v5"
)

func waitProjectDeletionBlock(t *testing.T, ctx context.Context, db *postgres.Store, blocker int32) int32 {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int32
		err := db.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, blocker).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatalf("no waiter for backend %d: %v", blocker, ctx.Err())
		}
	}
}

func receiveProjectRace(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return nil
	}
}

func TestProjectDeletionOrdersClaimAndThread(t *testing.T) {
	for _, operation := range []string{"claim", "thread"} {
		for _, deletionFirst := range []bool{false, true} {
			for _, taskDeleted := range []bool{false, true} {
				if taskDeleted && (operation != "thread" || !deletionFirst) {
					continue
				}
				t.Run(operation+map[bool]string{true: "/deletion-first", false: "/operation-first"}[deletionFirst]+map[bool]string{true: "/deleted-task", false: ""}[taskDeleted], func(t *testing.T) {
					tasks, db, project, _, principal := taskService(t)
					task := createTask(t, tasks, principal, project.ID, "Thread")
					if operation == "claim" {
						task = claimableTask(t, tasks, principal, project.ID)
					}
					if taskDeleted {
						if err := tasks.Delete(context.Background(), principal, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version}); err != nil {
							t.Fatal(err)
						}
					}
					threads := taskservice.NewTaskThreads(db)
					projects := projectservice.NewProjects(db, sessioncore.NewEngine(nil))
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					target := `BEFORE UPDATE OF deleted_at ON projects`
					if !deletionFirst && operation == "claim" {
						target = `BEFORE INSERT ON task_properties`
					} else if !deletionFirst && operation == "thread" {
						target = `BEFORE INSERT ON task_thread_messages`
					}
					_, err := db.Pool.Exec(ctx, `CREATE FUNCTION block_project_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(13629020); RETURN NEW; END $$; CREATE TRIGGER block_project_race `+target+` FOR EACH ROW EXECUTE FUNCTION block_project_race()`)
					if err != nil {
						t.Fatal(err)
					}
					locker, err := db.Pool.Acquire(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer locker.Release()
					if _, err = locker.Exec(ctx, `SELECT pg_advisory_lock(13629020)`); err != nil {
						t.Fatal(err)
					}
					defer locker.Exec(context.Background(), `SELECT pg_advisory_unlock(13629020)`)
					mutation, deletion := make(chan error, 1), make(chan error, 1)
					startMutation := func() {
						go func() {
							if operation == "claim" {
								_, err := tasks.ClaimWorker(ctx, principal, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: workerDescriptor()})
								mutation <- err
							} else {
								_, err := threads.Post(ctx, principal, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "retained message"})
								mutation <- err
							}
						}()
					}
					startDeletion := func() { go func() { _, err := projects.Delete(ctx, principal, project.ID); deletion <- err }() }
					if deletionFirst {
						startDeletion()
					} else {
						startMutation()
					}
					firstPID := waitProjectDeletionBlock(t, ctx, db, int32(locker.Conn().PgConn().PID()))
					if deletionFirst {
						startMutation()
					} else {
						startDeletion()
					}
					waitProjectDeletionBlock(t, ctx, db, firstPID)
					if _, err = locker.Exec(ctx, `SELECT pg_advisory_unlock(13629020)`); err != nil {
						t.Fatal(err)
					}
					mutationErr := receiveProjectRace(t, ctx, mutation)
					deletionErr := receiveProjectRace(t, ctx, deletion)
					if deletionFirst {
						if deletionErr != nil {
							t.Fatalf("deletion: %v", deletionErr)
						}
						requireThreadFault(t, mutationErr, "not_found")
					} else if operation == "claim" {
						if mutationErr != nil {
							t.Fatalf("claim: %v", mutationErr)
						}
						requireThreadFault(t, deletionErr, "active_worker_claims")
					} else if mutationErr != nil || deletionErr != nil {
						t.Fatalf("thread=%v deletion=%v", mutationErr, deletionErr)
					}
					if operation == "thread" {
						var count int
						if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != map[bool]int{true: 0, false: 1}[deletionFirst] {
							t.Fatalf("retained thread count=%d, error=%v", count, err)
						}
					} else {
						var version int64
						var worker bool
						if err := db.Pool.QueryRow(ctx, `SELECT version,EXISTS(SELECT 1 FROM task_properties WHERE task_id=$1 AND name='worker') FROM tasks WHERE id=$1`, task.ID).Scan(&version, &worker); err != nil || worker == deletionFirst || version != task.Version+map[bool]int64{true: 0, false: 1}[deletionFirst] {
							t.Fatalf("claim state: version=%d worker=%v error=%v", version, worker, err)
						}
					}
				})
			}
		}
	}
}

func TestDeletedProjectThreadListAndLiveProjectDenial(t *testing.T) {
	tasks, db, project, _, principal := taskService(t)
	ctx := context.Background()
	live := createTask(t, tasks, principal, project.ID, "Live")
	deleted := createTask(t, tasks, principal, project.ID, "Deleted")
	threads := taskservice.NewTaskThreads(db)
	outsider := servicePrincipal(t, db)
	_, err := threads.Post(ctx, outsider, project.ID, live.ID, taskservice.CreateThreadMessage{Body: "denied"})
	requireThreadFault(t, err, "forbidden")
	_, err = threads.List(ctx, outsider, project.ID, live.ID, taskservice.ThreadListRequest{})
	requireThreadFault(t, err, "forbidden")
	if err = tasks.Delete(ctx, principal, project.ID, deleted.ID, taskcore.DeleteTask{Version: deleted.Version}); err != nil {
		t.Fatal(err)
	}
	_, err = threads.List(ctx, principal, project.ID, deleted.ID, taskservice.ThreadListRequest{})
	requireThreadFault(t, err, "task_deleted")
	projects := projectservice.NewProjects(db, sessioncore.NewEngine(nil))
	if _, err = projects.Delete(ctx, principal, project.ID); err != nil {
		t.Fatal(err)
	}
	for _, task := range []string{live.ID, deleted.ID} {
		_, err = threads.List(ctx, principal, project.ID, task, taskservice.ThreadListRequest{})
		requireThreadFault(t, err, "not_found")
	}
}

func TestProjectDeletionWaitingStatementUsesOldProjectSnapshot(t *testing.T) {
	tasks, db, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	deletion, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	if _, err = deletion.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = deletion.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = deletion.Exec(ctx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, project.ID); err != nil {
		t.Fatal(err)
	}
	waiter, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Rollback(context.Background())
	result := make(chan error, 1)
	go func() {
		var selected bool
		err := waiter.QueryRow(ctx, `SELECT p.deleted_at IS NULL FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.deleted_at IS NULL FOR SHARE OF t`, task.ID).Scan(&selected)
		if err == nil && !selected {
			err = fmt.Errorf("waiting statement did not observe the original live Project")
		}
		result <- err
	}()
	waitProjectDeletionBlock(t, ctx, db, int32(deletion.Conn().PgConn().PID()))
	if err = deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = receiveProjectRace(t, ctx, result); err != nil {
		t.Fatalf("waiting statement: %v", err)
	}
	var live bool
	if err = waiter.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, project.ID).Scan(&live); err != nil || live {
		t.Fatalf("fresh statement: live=%v error=%v", live, err)
	}
}

func TestProjectDeletionAuthorizationAfterTransferAndReturn(t *testing.T) {
	tasks, db, project, _, original := taskService(t)
	ctx := context.Background()
	other := servicePrincipal(t, db)
	teams := teamservice.NewTeams(db)
	target, err := teams.Create(ctx, other, coreteam.CreateTeam{Name: "Destination", ExpectedUserID: other.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID); err != nil {
		t.Fatal(err)
	}
	projects := projectservice.NewProjects(db, sessioncore.NewEngine(nil))
	if _, err = projects.DeletionPreview(ctx, original, project.ID, model.PageRequest{Limit: 50}); err != nil {
		t.Fatal(err)
	}
	_, err = projects.Delete(ctx, other, project.ID)
	requireThreadFault(t, err, "forbidden")
	task := claimWorkerTask(t, tasks, original, claimableTask(t, tasks, original, project.ID), workerDescriptor())
	claim := testWorker(t, task.Properties)
	move := func(actor model.Principal, targetID string) {
		preview, err := projects.TransferPreview(ctx, actor, project.ID, targetID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = projects.Transfer(ctx, actor, project.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: targetID, Version: preview.TargetTeamVersion}, ExpectedUserID: actor.UserID})
		if err != nil {
			t.Fatal(err)
		}
	}
	move(original, target.ID)
	_, err = projects.Delete(ctx, original, project.ID)
	requireThreadFault(t, err, "forbidden")
	_, err = projects.Delete(ctx, other, project.ID)
	requireThreadFault(t, err, "active_worker_claims")
	move(other, project.Ownership.TeamID)
	_, err = projects.Delete(ctx, other, project.ID)
	requireThreadFault(t, err, "forbidden")
	_, err = projects.Delete(ctx, original, project.ID)
	requireThreadFault(t, err, "active_worker_claims")
	if _, err = tasks.SetStatus(ctx, original, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &claim.ClaimID}); err != nil {
		t.Fatal(err)
	}
	receipt, err := projects.Delete(ctx, original, project.ID)
	if err != nil || !receipt.Deleted || receipt.ProjectID != project.ID {
		t.Fatalf("delete after transfer back: %+v %v", receipt, err)
	}
}
