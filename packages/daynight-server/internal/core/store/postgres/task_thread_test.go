package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
