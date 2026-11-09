package postgres

import (
	"context"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

func waitThreadBackendLock(t *testing.T, database *Store, pid uint32) {
	t.Helper()
	testutil.WaitThreadBackendLock(t, database.Pool, pid)
}

func TestThreadTaskShareLockAllowsAppendWhileProjectMutationWaits(t *testing.T) {
	for _, mutation := range []string{"delete", "source status"} {
		t.Run(mutation, func(t *testing.T) {
			database, principal, _, project := membershipFixture(t)
			task := queryTask(t, database, project.ID, 10, model.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			connection, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Rollback(context.Background())
			thread := &ThreadTx{tx: connection}
			if _, err := thread.TaskDAO().LockTaskPresence(ctx, project.ID, task.ID); err != nil {
				t.Fatal(err)
			}
			started := make(chan uint32, 1)
			completed := make(chan error, 1)
			go func() {
				completed <- writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
					started <- tx.(*ProjectTx).tx.Conn().PgConn().PID()
					if _, err := tx.TaskDAO().Task(ctx, task.ID); err != nil {
						return err
					}
					if mutation == "delete" {
						_, err := tx.TaskDAO().DeleteTask(ctx, task.ID, false)
						return err
					}
					_, err := tx.(*ProjectTx).tx.Exec(ctx, `UPDATE tasks SET status='in_progress' WHERE id=$1`, task.ID)
					return err
				})
			}()
			waitThreadBackendLock(t, database, <-started)
			// The ordinary writer now owns the project row. Thread may not acquire
			// a project lock after its task lock or both transactions would deadlock.
			if _, err := thread.CredentialDAO().Credential(ctx, principal); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.ProjectDAO().LockProjectAuthorization(ctx, principal, project.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.ThreadDAO().LockHead(ctx, task.ID); err != nil {
				t.Fatal(err)
			}
			message, err := thread.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: "authorized before mutation"})
			if err != nil {
				t.Fatal(err)
			}
			if err := thread.ThreadDAO().AdvanceHead(ctx, task.ID, message.Position()); err != nil {
				t.Fatal(err)
			}
			if err := connection.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-completed; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestThreadCredentialAndGrantLocksBlockRevocation(t *testing.T) {
	for _, mutation := range []string{"credential", "grant"} {
		t.Run(mutation, func(t *testing.T) {
			database, principal, _, project := membershipFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			connection, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Rollback(context.Background())
			thread := &ThreadTx{tx: connection}
			if _, err := thread.CredentialDAO().Credential(ctx, principal); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.ProjectDAO().LockProjectAuthorization(ctx, principal, project.ID); err != nil {
				t.Fatal(err)
			}
			revoker, err := database.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer revoker.Release()
			completed := make(chan error, 1)
			go func() {
				if mutation == "credential" {
					_, err := revoker.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, principal.CredentialID)
					completed <- err
					return
				}
				_, err := revoker.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
				completed <- err
			}()
			waitThreadBackendLock(t, database, revoker.Conn().PgConn().PID())
			if err := connection.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-completed; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestThreadSnapshotRetainsItsAuthorizedMessagesAndTaskPresence(t *testing.T) {
	database, _, principal, project := membershipFixture(t)
	if err := writeProjectForTest(database, context.Background(), project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	first := appendStoredThread(t, database, task.ID, principal.UserID, "original")
	ctx := context.Background()
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
			return err
		}
		if _, err := snapshot.ProjectDAO().ProjectAccess(ctx, principal, project.ID); err != nil {
			return err
		}
		appendStoredThread(t, database, task.ID, principal.UserID, "outside snapshot")
		mustQueryExec(t, database, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID)
		mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
		presence, err := snapshot.TaskDAO().TaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("snapshot presence changed: %#v %v", presence, err)
		}
		if _, err := snapshot.ProjectDAO().ProjectAccess(ctx, principal, project.ID); err != nil {
			t.Fatalf("snapshot membership changed: %v", err)
		}
		items, err := snapshot.TaskDAO().ThreadCandidates(ctx, task.ID, nil, false, 10)
		if err != nil || len(items) != 1 || items[0].ID != first.ID {
			t.Fatalf("snapshot messages changed: %#v %v", items, err)
		}
		before, after, err := snapshot.TaskDAO().ThreadSides(ctx, task.ID, first.Position(), first.Position())
		if err != nil || before || after {
			t.Fatalf("snapshot sides changed with concurrent append: before=%v after=%v error=%v", before, after, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		presence, err := snapshot.TaskDAO().TaskPresence(ctx, project.ID, task.ID)
		if err != nil || presence.DeletedAt == nil {
			t.Fatalf("new snapshot missed deletion: %#v %v", presence, err)
		}
		if _, err := snapshot.ProjectDAO().ProjectAccess(ctx, principal, project.ID); err == nil {
			t.Fatal("new snapshot retained revoked membership")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestThreadHeadLockCancellationReleasesConnection(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	locker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback(context.Background())
	if _, err := locker.Exec(ctx, `INSERT INTO task_threads(task_id) VALUES($1)`, queryID(1)); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	err = threadTestWrite(database, bounded, func(tx ThreadScope) error { _, err := tx.ThreadDAO().LockHead(bounded, queryID(1)); return err })
	if err == nil {
		t.Fatal("head lock ignored cancellation")
	}
	if err := locker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, database.Pool)
	if _, err := database.Pool.Exec(ctx, `SELECT task_id FROM task_threads FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
}

var _ pgx.Tx = (*threadCommitResponseLoss)(nil)
