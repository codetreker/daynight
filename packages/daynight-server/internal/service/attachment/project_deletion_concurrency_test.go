package attachment

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

// markProjectDeleted uses the deletion writer's actual Project/Task barrier.
// Session retirement is outside the attachment ordering checked here.
func markProjectDeleted(ctx context.Context, database *postgres.Store, projectID string) error {
	completion, err := database.WriteProjectDeletion(ctx, projectID, func(scope store.ProjectDeletionScope) error {
		changed, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("project deletion did not mark a row")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return fmt.Errorf("project deletion completion: %s", completion.Outcome)
	}
	return nil
}

func TestAttachmentMutationBlocksProjectDeletion(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		t.Run(operation, func(t *testing.T) {
			attachments, _, database, files, task, principal := attachmentService(t)
			if operation != "put" {
				putAttachment(t, attachments, principal, task, "file", "before")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			observed := &observedAttachmentStorage{Storage: files, reached: make(chan struct{}), release: make(chan struct{})}
			mutation := make(chan error, 1)
			go func() {
				mutation <- attachmentMutation(ctx, newAttachmentService(database, observed), principal, task, operation)
			}()
			select {
			case <-observed.reached:
			case err := <-mutation:
				t.Fatalf("mutation did not reach file operation: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			released := false
			defer func() {
				if !released {
					close(observed.release)
				}
			}()
			var blocker int32
			if err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity
              WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%task_attachments%' LIMIT 1),0)`).Scan(&blocker); err != nil || blocker == 0 {
				t.Fatalf("attachment transaction not found: %d %v", blocker, err)
			}
			deletion := make(chan error, 1)
			go func() { deletion <- markProjectDeleted(ctx, database, task.ProjectID) }()
			waitAttachmentBlocked(t, ctx, database, blocker)
			close(observed.release)
			released = true
			if err := attachmentWaitResult(t, ctx, mutation); err != nil {
				t.Fatalf("attachment mutation: %v", err)
			}
			if err := attachmentWaitResult(t, ctx, deletion); err != nil {
				t.Fatalf("project deletion: %v", err)
			}
			assertAttachmentState(t, ctx, database, files, task, operation != "delete", "after")
		})
	}
}

func TestProjectDeletionOrdersAttachmentMutations(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		for _, taskDeleted := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/task_deleted=%t", operation, taskDeleted), func(t *testing.T) {
				attachments, tasks, database, files, task, principal := attachmentService(t)
				if operation != "put" {
					putAttachment(t, attachments, principal, task, "file", "before")
				}
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if taskDeleted {
					if err := tasks.Delete(ctx, principal, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version}); err != nil {
						t.Fatal(err)
					}
				}
				var original *string
				if err := database.Pool.QueryRow(ctx, `SELECT (SELECT to_jsonb(a)::text FROM task_attachments a WHERE task_id=$1 AND path='file')`, task.ID).Scan(&original); err != nil {
					t.Fatal(err)
				}
				if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION block_project_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(13629019); RETURN NEW; END $$;
                  CREATE TRIGGER block_project_delete BEFORE UPDATE OF deleted_at ON projects FOR EACH ROW EXECUTE FUNCTION block_project_delete()`); err != nil {
					t.Fatal(err)
				}
				locker, err := database.Pool.Acquire(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer locker.Release()
				if _, err := locker.Exec(ctx, `SELECT pg_advisory_lock(13629019)`); err != nil {
					t.Fatal(err)
				}
				defer locker.Exec(context.Background(), `SELECT pg_advisory_unlock(13629019)`)
				deletion := make(chan error, 1)
				go func() { deletion <- markProjectDeleted(ctx, database, task.ProjectID) }()
				deletingPID := waitAttachmentBlocked(t, ctx, database, int32(locker.Conn().PgConn().PID()))
				observed := &observedAttachmentStorage{Storage: files}
				mutation := make(chan error, 1)
				go func() {
					mutation <- attachmentMutation(ctx, newAttachmentService(database, observed), principal, task, operation)
				}()
				waitAttachmentBlocked(t, ctx, database, deletingPID)
				if observed.calls.Load() != 0 {
					t.Fatal("file operation ran before project deletion committed")
				}
				if _, err := locker.Exec(ctx, `SELECT pg_advisory_unlock(13629019)`); err != nil {
					t.Fatal(err)
				}
				if err := attachmentWaitResult(t, ctx, deletion); err != nil {
					t.Fatalf("project deletion: %v", err)
				}
				requireFault(t, attachmentWaitResult(t, ctx, mutation), "not_found")
				if observed.calls.Load() != 0 {
					t.Fatal("deleted Project changed physical content")
				}
				assertAttachmentState(t, ctx, database, files, task, operation != "put", "before")
				var after *string
				if err := database.Pool.QueryRow(ctx, `SELECT (SELECT to_jsonb(a)::text FROM task_attachments a WHERE task_id=$1 AND path='file')`, task.ID).Scan(&after); err != nil {
					t.Fatal(err)
				}
				if (after == nil) != (original == nil) || after != nil && *after != *original {
					t.Fatalf("metadata changed: before=%v after=%v", original, after)
				}
			})
		}
	}
}
