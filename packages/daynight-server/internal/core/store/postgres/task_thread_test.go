package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func appendStoredThread(t *testing.T, database *Store, taskID, userID, body string) model.ThreadMessage {
	t.Helper()
	ctx := context.Background()
	var message model.ThreadMessage
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		head, err := tx.ThreadDAO().LockHead(ctx, taskID)
		if err != nil {
			return err
		}
		message, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: taskID, Author: model.ThreadAuthor{UserID: userID}, Body: body})
		if err != nil {
			return err
		}
		if err := tx.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		return tx.ThreadDAO().AdvanceHead(ctx, taskID, message.Position())
	})
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func TestThreadMigrationDefaultsCompositeIdentityAndRestart(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:28]); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	var defaultValue, primary, order string
	var unique, foreignKeys bool
	if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='task_thread_messages' AND column_name='message_id'`).Scan(&defaultValue); err != nil || defaultValue != "gen_random_uuid()" {
		t.Fatalf("UUID default: %q %v", defaultValue, err)
	}
	if err := pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='task_thread_messages'::regclass AND contype='p'`).Scan(&primary); err != nil || primary != "PRIMARY KEY (task_id, message_id)" {
		t.Fatalf("composite primary key: %q %v", primary, err)
	}
	if err := pool.QueryRow(ctx, `SELECT indisunique,pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='task_thread_messages_order'::regclass`).Scan(&unique, &order); err != nil || unique || !strings.Contains(order, "(task_id, created_at, message_id)") {
		t.Fatalf("ordinary order index: %v %q %v", unique, order, err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN('task_threads'::regclass,'task_thread_messages'::regclass) AND contype='f')`).Scan(&foreignKeys); err != nil || foreignKeys {
		t.Fatalf("unexpected foreign keys: %v %v", foreignKeys, err)
	}
	first := appendStoredThread(t, database, queryID(1), queryID(9), "database UUID")
	if len(first.ID) != 36 || first.CreatedAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("database identity or precision: %#v", first)
	}
	for _, taskID := range []string{queryID(2), queryID(3)} {
		mustQueryExec(t, database, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body) VALUES($1,$2,'2026-01-02T03:04:05.123Z',$3,false,$4)`, taskID, queryID(99), queryID(9), taskID)
	}
	_, err := pool.Exec(ctx, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body) VALUES($1,$2,clock_timestamp(),$3,false,'duplicate')`, queryID(2), queryID(99), queryID(9))
	var postgres *pgconn.PgError
	if !errors.As(err, &postgres) || postgres.Code != "23505" {
		t.Fatalf("same-task duplicate accepted: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		for _, taskID := range []string{queryID(2), queryID(3)} {
			message, err := snapshot.TaskDAO().ThreadMessage(ctx, taskID, queryID(99))
			if err != nil || message.Body != taskID {
				t.Fatalf("cross-task identity: %#v %v", message, err)
			}
		}
		_, err := snapshot.TaskDAO().ThreadMessage(ctx, queryID(1), queryID(99))
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("foreign task message resolved: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`INSERT INTO task_threads(task_id,last_created_at) VALUES('00000000-0000-4000-8000-000000000010',now())`,
		`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES(gen_random_uuid(),now(),gen_random_uuid(),true,'missing execution')`,
		`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,author_provider,body) VALUES(gen_random_uuid(),now(),gen_random_uuid(),false,'codex','unexpected execution')`,
	} {
		_, err := pool.Exec(ctx, sql)
		if !errors.As(err, &postgres) || postgres.Code != "23514" {
			t.Fatalf("thread consistency constraint accepted: %v", err)
		}
	}
}

func TestThreadRejectedAppendRollsBackCandidateAndLazyHead(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	rejected := errors.New("reject after insertion")
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.ThreadDAO().LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		if _, err := tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "rejected"}); err != nil {
			return err
		}
		return rejected
	})
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || !errors.Is(err, rejected) || failure.CommitAttempted || failure.RollbackFailed {
		t.Fatalf("callback classification: %#v %v", failure, err)
	}
	for _, table := range []string{"task_threads", "task_thread_messages"} {
		var count int
		if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected %s persisted: %d %v", table, count, err)
		}
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestThreadClosedTransactionsKeepStoreFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	var closed ThreadScope
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error { closed = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	checks := []func() error{
		func() error { _, err := closed.TaskDAO().LockTaskPresence(ctx, queryID(1), queryID(2)); return err },
		func() error {
			_, err := closed.CredentialDAO().Credential(ctx, model.Principal{Kind: model.PATCredential, UserID: queryID(1), CredentialID: queryID(2)})
			return err
		},
		func() error {
			_, err := closed.ProjectDAO().LockProjectAuthorization(ctx, model.Principal{UserID: queryID(1)}, queryID(2))
			return err
		},
		func() error { _, err := closed.CredentialDAO().AuthorName(ctx, queryID(1)); return err },
		func() error { _, err := closed.TaskDAO().SourceTask(ctx, queryID(1), queryID(2)); return err },
		func() error { _, err := closed.ThreadDAO().LockHead(ctx, queryID(1)); return err },
		func() error { _, err := closed.ThreadDAO().ThreadMessage(ctx, queryID(1), queryID(2)); return err },
		func() error {
			_, err := closed.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1)})
			return err
		},
		func() error { _, err := closed.CredentialDAO().CredentialValid(ctx, ThreadCredential{}); return err },
		func() error {
			return closed.ThreadDAO().AdvanceHead(ctx, queryID(1), model.ThreadPosition{CreatedAt: time.Now(), ID: queryID(2)})
		},
	}
	for index, check := range checks {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) || strings.Contains(err.Error(), "SELECT") {
			t.Fatalf("closed method %d cause lost or leaked: %v", index, err)
		}
	}
	var snapshot SnapshotScope
	if err := database.ReadSnapshot(ctx, func(tx SnapshotScope) error { snapshot = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, check := range []func() error{
		func() error {
			_, err := snapshot.TaskDAO().ThreadCandidates(ctx, queryID(1), nil, false, 2)
			return err
		},
		func() error {
			_, _, err := snapshot.TaskDAO().ThreadSides(ctx, queryID(1), model.ThreadPosition{}, model.ThreadPosition{})
			return err
		},
	} {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read cause lost: %v", err)
		}
	}
}

func TestThreadClockExhaustionDoesNotPublishInsertedCandidate(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	var candidate model.ThreadMessage
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.ThreadDAO().LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		var err error
		candidate, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "must roll back"})
		if err != nil {
			return err
		}
		head := &model.ThreadPosition{CreatedAt: candidate.CreatedAt.Add(time.Hour), ID: queryID(1)}
		return tx.ThreadDAO().PrepareTimestamp(ctx, &candidate, head)
	})
	var clock *ThreadClockError
	var transaction *ThreadTransactionError
	if !errors.As(err, &clock) || !errors.As(err, &transaction) || transaction.CommitAttempted {
		t.Fatalf("clock refusal classification: %v", err)
	}
	// Expiry during an active pgx sample can discard the connection. In that
	// case cleanup failure remains internal rather than claiming confirmed rollback.
	if transaction.RollbackFailed && transaction.Phase != "rollback" {
		t.Fatalf("cleanup failure classification lost: %#v", transaction)
	}
	var heads, messages int
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_threads),(SELECT count(*) FROM task_thread_messages)`).Scan(&heads, &messages); err != nil || heads != 0 || messages != 0 {
		t.Fatalf("clock refusal persisted data: heads=%d messages=%d %v", heads, messages, err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

type threadCommitResponseLoss struct {
	pgx.Tx
	cause error
}

func (tx *threadCommitResponseLoss) Commit(ctx context.Context) error {
	if err := tx.Tx.Commit(ctx); err != nil {
		return err
	}
	return tx.cause
}

func TestThreadCommitAppliedWithLostResponseRemainsUnknown(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("commit response lost")
	completion, err := writeThread(ctx, &threadCommitResponseLoss{Tx: tx, cause: cause}, func(tx ThreadScope) error {
		_, err := tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "committed once"})
		return err
	})
	var failure *ThreadTransactionError
	if completion.Outcome != TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !failure.OutcomeUnknown || failure.RollbackFailed || !errors.Is(err, cause) || failure.Phase != "commit" {
		t.Fatalf("unknown commit classification: %#v %v", failure, err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("real commit not observed: %d %v", count, err)
	}
	if failure.Error() != "thread transaction commit failed" {
		t.Fatal("transaction diagnostic exposed upstream cause")
	}
}

func TestThreadAbortedCommitIsConfirmedRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	completion, err := database.WriteThread(ctx, func(tx ThreadScope) error {
		_, _ = tx.(*ThreadTx).tx.Exec(ctx, "SELECT 1/0")
		return nil
	})
	var failure *ThreadTransactionError
	if completion.Outcome != TransactionNotCommitted || !errors.As(err, &failure) || !failure.CommitAttempted || failure.OutcomeUnknown || !errors.Is(err, pgx.ErrTxCommitRollback) {
		t.Fatalf("confirmed commit rejection: %#v %v", failure, err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestThreadRollbackKeepsCancellationAndCleanupCause(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cleanup := errors.New("cleanup failed")
	wrapped := &rollbackFailureTx{Tx: tx, failure: cleanup}
	completion, err := writeThread(ctx, wrapped, func(tx ThreadScope) error {
		_, err := tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "canceled"})
		if err != nil {
			return err
		}
		cancel()
		return context.Canceled
	})
	var failure *ThreadTransactionError
	if completion.Outcome != TransactionUnknown || !errors.As(err, &failure) || !failure.RollbackFailed || failure.CommitAttempted || !errors.Is(err, context.Canceled) || !errors.Is(err, cleanup) || !wrapped.bounded {
		t.Fatalf("rollback failure chain: %#v %v bounded=%v", failure, err, wrapped.bounded)
	}
	assertMigrationPoolReusable(t, database.Pool)
	var count int
	if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM task_thread_messages`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("canceled message committed: %d %v", count, err)
	}
}

func TestThreadCancellationBeforeCommitAndPanicCleanup(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	completion, err := database.WriteThread(ctx, func(tx ThreadScope) error { cancel(); return nil })
	var failure *ThreadTransactionError
	if completion.Outcome != TransactionNotCommitted || !errors.As(err, &failure) || failure.CommitAttempted || !errors.Is(err, context.Canceled) {
		t.Fatalf("precommit cancellation: %#v %v", failure, err)
	}
	func() {
		defer func() {
			if recover() != "thread panic" {
				t.Fatal("panic not propagated")
			}
		}()
		_ = threadTestWrite(database, context.Background(), func(ThreadScope) error { panic("thread panic") })
	}()
	assertMigrationPoolReusable(t, database.Pool)
	err = threadTestWrite(database, ctx, func(ThreadScope) error { t.Fatal("callback reached canceled begin"); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled begin cause lost: %v", err)
	}
}

func waitThreadBackendLock(t *testing.T, database *Store, pid uint32) {
	t.Helper()
	testutil.WaitThreadBackendLock(t, database.Pool, pid)
}

func TestThreadTaskShareLockAllowsAppendWhileProjectMutationWaits(t *testing.T) {
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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

type threadAdmissionStore struct {
	*Store
	started  chan uint32
	hold     chan struct{}
	admitted chan struct{}
}

func (s *threadAdmissionStore) WriteThread(ctx context.Context, work func(ThreadScope) error) (Completion, error) {
	return s.Store.WriteThread(ctx, func(tx ThreadScope) error {
		s.started <- tx.(*ThreadTx).tx.Conn().PgConn().PID()
		err := work(tx)
		if err == nil && s.hold != nil {
			close(s.admitted)
			select {
			case <-s.hold:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return err
	})
}

func TestScopedThreadPolicyEditSerializesWithPost(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.MCP, scopepolicy.PAT} {
		t.Run(string(kind), func(t *testing.T) {
			db, owner, _, project := membershipFixture(t)
			target := queryTask(t, db, project.ID, 10, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			credential, grant := uuid.NewString(), uuid.NewString()
			hash := sha256.Sum256([]byte(credential))
			var table, id string
			principal := model.Principal{UserID: owner.UserID, CredentialID: credential}
			profile := model.ScopedPATProfile
			if kind == scopepolicy.PAT {
				principal.Kind, table, id = model.PATCredential, "personal_access_tokens", credential
				mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'Thread',now(),now()+interval '1 day',ARRAY['thread:post'],1)`, credential, owner.UserID, hash[:])
			} else {
				principal.Kind, profile, table, id = model.OAuthCredential, model.ScopedMCPProfile, "oauth_grants", grant
				mustQueryExec(t, db, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 day',ARRAY['thread:post'],1)`, grant, owner.UserID)
				mustQueryExec(t, db, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, credential, grant, owner.UserID, hash[:])
			}
			policy, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"thread:post"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := model.CredentialAuthorization{Principal: principal, Profile: profile, Policy: &policy}
			wrapped := &threadAdmissionStore{Store: db, started: make(chan uint32, 1)}
			threads := service.NewScopedTaskThreads(service.NewTaskThreads(wrapped))
			editor, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer editor.Rollback(context.Background())
			if _, err := editor.Exec(ctx, `UPDATE `+table+` SET business_scopes=ARRAY['thread:read'],scope_version=2 WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := threads.Post(ctx, auth, project.ID, target.ID, service.CreateThreadMessage{Body: "must not commit", Receipt: true})
				done <- err
			}()
			waitThreadBackendLock(t, db, <-wrapped.started)
			if err := editor.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
				t.Fatalf("post after edit: %v", err)
			}
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, target.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("denied post persisted %d messages: %v", count, err)
			}
			mustQueryExec(t, db, `UPDATE `+table+` SET business_scopes=ARRAY['thread:post'],scope_version=3 WHERE id=$1`, id)
			wrapped.hold, wrapped.admitted = make(chan struct{}), make(chan struct{})
			go func() {
				_, err := threads.Post(ctx, auth, project.ID, target.ID, service.CreateThreadMessage{Body: "accepted before edit", Receipt: true})
				done <- err
			}()
			<-wrapped.started
			<-wrapped.admitted
			connection, err := db.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Release()
			edited := make(chan error, 1)
			go func() {
				_, err := connection.Exec(ctx, `UPDATE `+table+` SET business_scopes=ARRAY['thread:read'],scope_version=4 WHERE id=$1`, id)
				edited <- err
			}()
			waitThreadBackendLock(t, db, connection.Conn().PgConn().PID())
			close(wrapped.hold)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if err := <-edited; err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1 AND body='accepted before edit'`, target.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("accepted post persisted %d messages: %v", count, err)
			}
		})
	}
}
