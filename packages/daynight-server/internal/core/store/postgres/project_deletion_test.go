package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestProjectDeletionWorkerSnapshotAndCompletion(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx := context.Background()
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: actor.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	lastSeen := time.Now().UTC().Truncate(time.Microsecond)
	mustQueryExec(t, s, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,$3,$3,'{}','{}')`, actor.UserID, claim.WorkerID, lastSeen)
	for i := 1; i <= 130; i++ {
		id := queryID(i)
		mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,status,deleted_at) VALUES($1,$2,$3,'todo',CASE WHEN $4 THEN now() END)`, id, project.ID, fmt.Sprintf("Task %d", i), i == 130)
		mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, string(raw))
	}
	mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, queryID(130))
	mustQueryExec(t, s, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'x','text/plain',1),($1,$3,'x','text/plain',1)`, project.ID, queryID(1), queryID(130))
	err = s.ReadProjectDeletion(ctx, project.ID, func(snapshot store.ProjectDeletionSnapshot) error {
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil || !access.CanTransfer {
			return fmt.Errorf("access: %+v %w", access, err)
		}
		summary, err := snapshot.Summary(ctx)
		if err != nil {
			return err
		}
		if summary.TaskCount != 129 || summary.UnfinishedTaskCount != 129 || summary.AttachmentCount != 1 {
			return fmt.Errorf("summary: %+v", summary)
		}
		count := 0
		err = snapshot.VisitTaskWorkers(ctx, func(f store.ProjectDeletionWorker) error {
			count++
			if f.Worker == nil || f.Worker.ClaimID != claim.ClaimID || f.LastSeenAt == nil || !f.LastSeenAt.Equal(lastSeen) || f.Paused != (f.TaskID == queryID(130)) {
				return fmt.Errorf("worker: %+v", f)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if count != 130 {
			return fmt.Errorf("worker count %d", count)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("rollback")
	c, err := s.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		access, err := scope.ProjectDAO().Authorization(ctx, actor)
		if err != nil || !access.CanTransfer {
			return fmt.Errorf("authorization: %+v %w", access, err)
		}
		if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
			if item.Title != "" {
				return errors.New("deletion scan loaded task title")
			}
			return nil
		}); err != nil {
			return err
		}
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !marked {
			return fmt.Errorf("mark: %t %w", marked, err)
		}
		return sentinel
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	c, err = s.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		ok, e := scope.ProjectDAO().MarkDeleted(ctx)
		if e != nil {
			return e
		}
		if !ok {
			return errors.New("not marked")
		}
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", c, err)
	}
	c, err = s.WriteProjectDeletion(ctx, project.ID, func(store.ProjectDeletionScope) error { return nil })
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("second deletion: %+v %v", c, err)
	}
}

func TestProjectDeletionRejectsCorruptWorker(t *testing.T) {
	s, _, _, project := membershipFixture(t)
	ctx := context.Background()
	for _, raw := range []string{"null", "{", "{}"} {
		id := uuid.NewString()
		mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'bad')`, id, project.ID)
		mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, raw)
		err := s.ReadProjectDeletion(ctx, project.ID, func(snapshot store.ProjectDeletionSnapshot) error {
			return snapshot.VisitTaskWorkers(ctx, func(store.ProjectDeletionWorker) error { return nil })
		})
		if err == nil {
			t.Fatalf("accepted corrupt worker %q", raw)
		}
		mustQueryExec(t, s, `DELETE FROM task_properties WHERE task_id=$1`, id)
		mustQueryExec(t, s, `DELETE FROM tasks WHERE id=$1`, id)
	}
}

func TestProjectDeletionWaitsForDeletedTask(t *testing.T) {
	s, _, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,deleted_at) VALUES($1,$2,'historical',now())`, id, project.ID)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.WriteProjectDeletion(ctx, project.ID, func(store.ProjectDeletionScope) error { return nil })
		done <- err
	}()
	waitTransferTeamLock(t, ctx, s, "SELECT id FROM tasks WHERE project_id=", tx.Conn().PgConn().PID())
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = receiveQueryResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
}
