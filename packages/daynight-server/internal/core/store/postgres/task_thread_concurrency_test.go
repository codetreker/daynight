package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
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
	messages := make(chan model.ThreadMessage, total)
	failures := make(chan error, total)
	var group sync.WaitGroup
	for index := range total {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			var message model.ThreadMessage
			err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
				head, err := tx.ThreadDAO().LockHead(ctx, queryID(1))
				if err != nil {
					return err
				}
				message, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: fmt.Sprint(index)})
				if err != nil {
					return err
				}
				if err := tx.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
					return err
				}
				return tx.ThreadDAO().AdvanceHead(ctx, queryID(1), message.Position())
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
	items := make([]model.ThreadMessage, 0, total)
	for message := range messages {
		items = append(items, message)
	}
	if len(items) != total {
		t.Fatalf("concurrent first appends: %d", len(items))
	}
	slices.SortFunc(items, func(a, b model.ThreadMessage) int {
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
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		head, err := tx.ThreadDAO().LockHead(ctx, queryID(1))
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
	var message model.ThreadMessage
	go func() {
		completed <- threadTestWrite(database, ctx, func(tx ThreadScope) error {
			started <- tx.(*ThreadTx).tx.Conn().PgConn().PID()
			head, err := tx.ThreadDAO().LockHead(ctx, queryID(1))
			if err != nil {
				return err
			}
			message, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "after lock"})
			if err != nil {
				return err
			}
			if err := tx.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
				return err
			}
			return tx.ThreadDAO().AdvanceHead(ctx, queryID(1), message.Position())
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

func TestThreadAuthorizationRechecksGrantAfterLockWait(t *testing.T) {
	for _, mutation := range []string{"role", "delete"} {
		t.Run(mutation, func(t *testing.T) {
			database, _, principal, project := membershipFixture(t)
			if err := writeProjectForTest(database, context.Background(), project.ID, func(tx ProjectWriteScope) error {
				_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			task := queryTask(t, database, project.ID, 10, model.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			writer, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(context.Background())
			var version int64
			if mutation == "role" {
				err = writer.QueryRow(ctx, `UPDATE project_grants SET role='member',version=nextval('project_grant_versions')
 WHERE project_id=$1 AND user_id=$2 RETURNING version`, project.ID, principal.UserID).Scan(&version)
			} else {
				_, err = writer.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan uint32, 1)
			completed := make(chan error, 1)
			var access model.ProjectAccess
			go func() {
				completed <- threadTestWrite(database, ctx, func(thread ThreadScope) error {
					started <- thread.(*ThreadTx).tx.Conn().PgConn().PID()
					if _, err := thread.TaskDAO().LockTaskPresence(ctx, project.ID, task.ID); err != nil {
						return err
					}
					if _, err := thread.CredentialDAO().Credential(ctx, principal); err != nil {
						return err
					}
					var err error
					access, err = thread.ProjectDAO().LockProjectAuthorization(ctx, principal, project.ID)
					return err
				})
			}()
			waitThreadBackendLock(t, database, <-started)
			if err := writer.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-completed
			if mutation == "delete" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("revoked grant admitted: %#v %v", access, err)
				}
				return
			}
			if err != nil || access.ProjectID != project.ID || access.UserID != principal.UserID || access.Role != model.ProjectMemberRole ||
				access.DirectGrant == nil || access.DirectGrant.ProjectID != project.ID || access.DirectGrant.UserID != principal.UserID ||
				access.DirectGrant.Role != access.Role || access.DirectGrant.Version != version {
				t.Fatalf("authorization retained pre-wait grant: %#v %v", access, err)
			}
		})
	}
}

func TestThreadAuthorizationUsesDestinationAfterOwnershipLockWait(t *testing.T) {
	for _, destinationCreatedLate := range []bool{false, true} {
		for _, destinationMember := range []bool{false, true} {
			t.Run(fmt.Sprintf("late=%t/member=%t", destinationCreatedLate, destinationMember), func(t *testing.T) {
				database, _, principal, project := membershipFixture(t)
				sourceID := ordinaryProjectTeam(t, database, project.ID)
				mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, sourceID, principal.UserID)
				task := queryTask(t, database, project.ID, 10, model.TaskTodo)
				destinationID := uuid.NewString()
				if !destinationCreatedLate {
					mustQueryExec(t, database, `INSERT INTO teams(id,name) VALUES($1,'Destination')`, destinationID)
					if destinationMember {
						mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, destinationID, principal.UserID)
					}
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				writer, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer writer.Rollback(context.Background())
				var locked string
				if err := writer.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE`, project.ID).Scan(&locked); err != nil || locked != sourceID {
					t.Fatalf("lock source ownership: %s %v", locked, err)
				}
				if destinationCreatedLate {
					if _, err := writer.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Destination')`, destinationID); err != nil {
						t.Fatal(err)
					}
					if destinationMember {
						if _, err := writer.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, destinationID, principal.UserID); err != nil {
							t.Fatal(err)
						}
					}
				}
				var destinationVersion int64
				if err := writer.QueryRow(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1 RETURNING version`, project.ID, destinationID).Scan(&destinationVersion); err != nil {
					t.Fatal(err)
				}
				started := make(chan uint32, 1)
				completed := make(chan error, 1)
				var access model.ProjectAccess
				go func() {
					completed <- threadTestWrite(database, ctx, func(thread ThreadScope) error {
						started <- thread.(*ThreadTx).tx.Conn().PgConn().PID()
						if _, err := thread.TaskDAO().LockTaskPresence(ctx, project.ID, task.ID); err != nil {
							return err
						}
						if _, err := thread.CredentialDAO().Credential(ctx, principal); err != nil {
							return err
						}
						var err error
						access, err = thread.ProjectDAO().LockProjectAuthorization(ctx, principal, project.ID)
						return err
					})
				}()
				var readerPID uint32
				select {
				case readerPID = <-started:
				case err := <-completed:
					t.Fatalf("thread failed before admission: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				// The blocked ownership statement has its old snapshot before
				// the writer publishes the destination.
				waitThreadBackendLock(t, database, readerPID)
				var waitingOnOwnership bool
				err = database.Pool.QueryRow(ctx, `SELECT query LIKE '%FROM project_ownership%' AND $2=ANY(pg_blocking_pids(pid))
 FROM pg_stat_activity WHERE pid=$1`, readerPID, writer.Conn().PgConn().PID()).Scan(&waitingOnOwnership)
				if err != nil || !waitingOnOwnership {
					t.Fatalf("thread did not wait for the ownership writer: %v", err)
				}
				if err := writer.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err = <-completed:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if !destinationMember {
					if !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("source-only access retained: %#v %v", access, err)
					}
				} else if err != nil || access.OwnerTeam.ID != destinationID || access.OwnerTeam.Name == nil || *access.OwnerTeam.Name != "Destination" ||
					access.Ownership.TeamID != destinationID || access.Ownership.Version != destinationVersion || access.Role != model.ProjectMemberRole ||
					access.DirectGrant != nil || access.TeamRole == nil || *access.TeamRole != model.ProjectMemberRole || access.CanTransfer {
					t.Fatalf("destination-only access: %#v %v", access, err)
				}
			})
		}
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
