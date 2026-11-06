package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestThreadTimestampWaitRetainsSingleDatabaseGeneratedUUID(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	mustQueryExec(t, database, `CREATE SEQUENCE thread_uuid_calls;
 CREATE FUNCTION thread_test_uuid() RETURNS uuid LANGUAGE SQL VOLATILE AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid FROM nextval('thread_uuid_calls') $$;
 ALTER TABLE task_thread_messages ALTER COLUMN message_id SET DEFAULT thread_test_uuid()`)
	var message model.ThreadMessage
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.ThreadDAO().LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		var stamp time.Time
		if err := tx.(*ThreadTx).tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())+interval '30 milliseconds'`).Scan(&stamp); err != nil {
			return err
		}
		head := &model.ThreadPosition{CreatedAt: stamp.UTC(), ID: "ffffffff-ffff-4fff-8fff-ffffffffffff"}
		if err := tx.ThreadDAO().AdvanceHead(ctx, queryID(1), *head); err != nil {
			return err
		}
		var err error
		message, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "one UUID"})
		if err != nil {
			return err
		}
		id := message.ID
		if err := tx.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		if message.ID != id || !message.CreatedAt.After(head.CreatedAt) {
			t.Fatalf("UUID regenerated or timestamp fabricated: %#v head=%#v", message, head)
		}
		return tx.ThreadDAO().AdvanceHead(ctx, queryID(1), message.Position())
	}); err != nil {
		t.Fatal(err)
	}
	var calls int
	if err := database.Pool.QueryRow(ctx, `SELECT last_value FROM thread_uuid_calls`).Scan(&calls); err != nil || calls != 1 || message.ID != queryID(1) {
		t.Fatalf("UUID generation count=%d id=%s %v", calls, message.ID, err)
	}
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		return tx.ThreadDAO().AdvanceHead(ctx, queryID(1), message.Position())
	}); err == nil {
		t.Fatal("head accepted non-forward update")
	}
}

func TestThreadClockExhaustionDoesNotPublishInsertedCandidate(t *testing.T) {
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
