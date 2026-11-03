package store

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func waitThreadBackendLock(t *testing.T, database *Store, pid uint32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT coalesce((SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1),false)`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("backend %d did not wait for lock: %v", pid, err)
		}
	}
}

func TestThreadFirstHeadConcurrencyPublishesStrictPositions(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const total = 24
	messages := make(chan core.ThreadMessage, total)
	failures := make(chan error, total)
	var group sync.WaitGroup
	for index := range total {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			var message core.ThreadMessage
			err := database.WriteThread(ctx, func(tx *ThreadTx) error {
				head, err := tx.LockHead(ctx, queryID(1))
				if err != nil {
					return err
				}
				message, err = tx.InsertMessage(ctx, core.ThreadMessage{TaskID: queryID(1), Author: core.ThreadAuthor{UserID: queryID(9)}, Body: fmt.Sprint(index)})
				if err != nil {
					return err
				}
				if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
					return err
				}
				return tx.AdvanceHead(ctx, queryID(1), message.Position())
			})
			if err != nil {
				failures <- err
				return
			}
			messages <- message
		}(index)
	}
	group.Wait()
	close(failures)
	close(messages)
	for err := range failures {
		t.Fatal(err)
	}
	items := make([]core.ThreadMessage, 0, total)
	for message := range messages {
		items = append(items, message)
	}
	if len(items) != total {
		t.Fatalf("concurrent first appends: %d", len(items))
	}
	slices.SortFunc(items, func(a, b core.ThreadMessage) int {
		if threadPositionAfter(a.Position(), b.Position()) {
			return 1
		}
		return -1
	})
	for index := 1; index < len(items); index++ {
		if !threadPositionAfter(items[index].Position(), items[index-1].Position()) {
			t.Fatal("concurrent positions are not strictly ordered")
		}
	}
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		head, err := tx.LockHead(ctx, queryID(1))
		if err != nil || head == nil || *head != items[len(items)-1].Position() {
			t.Fatalf("committed head: %#v %v", head, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestThreadSamplesDatabaseClockAfterHeadLockWait(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mustQueryExec(t, database, `INSERT INTO task_threads(task_id) VALUES($1)`, queryID(1))
	locker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback(context.Background())
	if _, err := locker.Exec(ctx, `SELECT task_id FROM task_threads WHERE task_id=$1 FOR UPDATE`, queryID(1)); err != nil {
		t.Fatal(err)
	}
	started := make(chan uint32, 1)
	completed := make(chan error, 1)
	var message core.ThreadMessage
	go func() {
		completed <- database.WriteThread(ctx, func(tx *ThreadTx) error {
			started <- tx.tx.Conn().PgConn().PID()
			head, err := tx.LockHead(ctx, queryID(1))
			if err != nil {
				return err
			}
			message, err = tx.InsertMessage(ctx, core.ThreadMessage{TaskID: queryID(1), Author: core.ThreadAuthor{UserID: queryID(9)}, Body: "after lock"})
			if err != nil {
				return err
			}
			if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
				return err
			}
			return tx.AdvanceHead(ctx, queryID(1), message.Position())
		})
	}()
	waitThreadBackendLock(t, database, <-started)
	var released time.Time
	if err := locker.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if err := locker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-completed; err != nil || message.CreatedAt.Before(released) {
		t.Fatalf("pre-lock clock used: message=%s released=%s %v", message.CreatedAt, released, err)
	}
}

func TestThreadTaskShareLockAllowsAppendWhileProjectMutationWaits(t *testing.T) {
	for _, mutation := range []string{"delete", "source status"} {
		t.Run(mutation, func(t *testing.T) {
			database, principal, _, project := membershipFixture(t)
			task := queryTask(t, database, project.ID, 10, core.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			connection, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Rollback(context.Background())
			thread := &ThreadTx{tx: connection}
			if _, err := thread.LockTaskPresence(ctx, project.ID, task.ID); err != nil {
				t.Fatal(err)
			}
			started := make(chan uint32, 1)
			completed := make(chan error, 1)
			go func() {
				completed <- database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
					started <- tx.tx.Conn().PgConn().PID()
					if _, err := tx.Task(ctx, task.ID); err != nil {
						return err
					}
					if mutation == "delete" {
						return tx.DeleteTask(ctx, task.ID, false)
					}
					_, err := tx.tx.Exec(ctx, `UPDATE tasks SET status='in_progress' WHERE id=$1`, task.ID)
					return err
				})
			}()
			waitThreadBackendLock(t, database, <-started)
			// The ordinary writer now owns the project row. Thread may not acquire
			// a project lock after its task lock or both transactions would deadlock.
			if _, err := thread.Credential(ctx, principal); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.ProjectMember(ctx, principal, project.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.LockHead(ctx, task.ID); err != nil {
				t.Fatal(err)
			}
			message, err := thread.InsertMessage(ctx, core.ThreadMessage{TaskID: task.ID, Author: core.ThreadAuthor{UserID: principal.UserID}, Body: "authorized before mutation"})
			if err != nil {
				t.Fatal(err)
			}
			if err := thread.AdvanceHead(ctx, task.ID, message.Position()); err != nil {
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

func TestThreadCredentialAndMembershipLocksBlockRevocation(t *testing.T) {
	for _, mutation := range []string{"credential", "membership"} {
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
			if _, err := thread.Credential(ctx, principal); err != nil {
				t.Fatal(err)
			}
			if _, err := thread.ProjectMember(ctx, principal, project.ID); err != nil {
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
				_, err := revoker.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
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
	database, principal, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, core.TaskTodo)
	first := appendStoredThread(t, database, task.ID, principal.UserID, "original")
	ctx := context.Background()
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if _, err := snapshot.Credential(ctx, principal); err != nil {
			return err
		}
		if _, err := snapshot.ProjectMember(ctx, principal, project.ID); err != nil {
			return err
		}
		appendStoredThread(t, database, task.ID, principal.UserID, "outside snapshot")
		mustQueryExec(t, database, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID)
		mustQueryExec(t, database, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
		presence, err := snapshot.TaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("snapshot presence changed: %#v %v", presence, err)
		}
		if _, err := snapshot.ProjectMember(ctx, principal, project.ID); err != nil {
			t.Fatalf("snapshot membership changed: %v", err)
		}
		items, err := snapshot.ThreadCandidates(ctx, task.ID, nil, false, 10)
		if err != nil || len(items) != 1 || items[0].ID != first.ID {
			t.Fatalf("snapshot messages changed: %#v %v", items, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		presence, err := snapshot.TaskPresence(ctx, project.ID, task.ID)
		if err != nil || presence.DeletedAt == nil {
			t.Fatalf("new snapshot missed deletion: %#v %v", presence, err)
		}
		if _, err := snapshot.ProjectMember(ctx, principal, project.ID); err == nil {
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
	err = database.WriteThread(bounded, func(tx *ThreadTx) error { _, err := tx.LockHead(bounded, queryID(1)); return err })
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
