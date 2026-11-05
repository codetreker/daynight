package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestThreadClockSamplesForwardWithoutChangingUUID(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Date(2026, 11, 3, 10, 0, 0, 123000000, time.UTC), ID: queryID(9)}
	candidate := model.ThreadPosition{CreatedAt: head.CreatedAt.Add(-time.Hour), ID: queryID(10)}
	if threadPositionAfter(candidate, head) {
		t.Fatal("an earlier timestamp bypassed clock recovery with a larger UUID")
	}
	// This UUID would sort after head at equal time, but once clock recovery is
	// needed the sampler must wait past the head millisecond regardless of UUID.
	samples := []time.Time{head.CreatedAt.Add(-time.Hour), head.CreatedAt, head.CreatedAt.Add(time.Millisecond)}
	calls, waits := 0, 0
	observed, err := forwardThreadClock(context.Background(), head, time.Second, func(ctx context.Context) (time.Time, error) {
		if _, present := ctx.Deadline(); !present {
			t.Fatal("sampling context has no deadline")
		}
		value := samples[calls]
		calls++
		return value, nil
	}, func(context.Context) error { waits++; return nil })
	if err != nil || observed != samples[2] || calls != 3 || waits != 2 {
		t.Fatalf("clock recovery: %s calls=%d waits=%d %v", observed, calls, waits, err)
	}
	if !threadPositionAfter(model.ThreadPosition{CreatedAt: head.CreatedAt, ID: queryID(10)}, head) || threadPositionAfter(head, head) {
		t.Fatal("same-millisecond UUID ordering changed")
	}
}

func TestThreadClockBudgetsSamplingAndKeepsParentCancellation(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Now().UTC(), ID: queryID(9)}
	for _, duringSample := range []bool{false, true} {
		t.Run(map[bool]string{false: "timer", true: "query"}[duringSample], func(t *testing.T) {
			started := time.Now()
			_, err := forwardThreadClock(context.Background(), head, 15*time.Millisecond, func(ctx context.Context) (time.Time, error) {
				if duringSample {
					<-ctx.Done()
					return time.Time{}, ctx.Err()
				}
				return head.CreatedAt.Add(-time.Second), nil
			}, waitThreadClock)
			var clock *ThreadClockError
			if !errors.As(err, &clock) || !errors.Is(err, context.DeadlineExceeded) || clock.Head != head || time.Since(started) > time.Second {
				t.Fatalf("clock budget classification: %#v %v", clock, err)
			}
			if !duringSample && clock.Observed != head.CreatedAt.Add(-time.Second) {
				t.Fatalf("last safe sample lost: %#v", clock)
			}
			if clock.Error() != "reliable forward clock position was not obtained within budget" {
				t.Fatal("clock error overstates cause")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, err := forwardThreadClock(ctx, head, time.Second, func(context.Context) (time.Time, error) {
		cancel()
		return head.CreatedAt, context.Canceled
	}, waitThreadClock)
	var clock *ThreadClockError
	if !errors.Is(err, context.Canceled) || errors.As(err, &clock) {
		t.Fatalf("parent cancellation reclassified as clock: %v", err)
	}
	_, err = forwardThreadClock(ctx, head, time.Second, func(context.Context) (time.Time, error) {
		t.Fatal("sample called after parent cancellation")
		return time.Time{}, nil
	}, waitThreadClock)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("initial cancellation lost: %v", err)
	}
	cause := errors.New("sampling failed")
	_, err = forwardThreadClock(context.Background(), head, time.Second,
		func(context.Context) (time.Time, error) { return time.Time{}, cause }, waitThreadClock)
	if !errors.Is(err, cause) || errors.As(err, &clock) {
		t.Fatalf("database failure became clock timeout: %v", err)
	}
	_, err = forwardThreadClock(context.Background(), head, time.Second,
		func(context.Context) (time.Time, error) { return head.CreatedAt, nil },
		func(context.Context) error { return cause })
	if !errors.Is(err, cause) || errors.As(err, &clock) {
		t.Fatalf("wait failure lost: %v", err)
	}
}

func TestThreadTimestampWaitRetainsSingleDatabaseGeneratedUUID(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	mustQueryExec(t, database, `CREATE SEQUENCE thread_uuid_calls;
 CREATE FUNCTION thread_test_uuid() RETURNS uuid LANGUAGE SQL VOLATILE AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid FROM nextval('thread_uuid_calls') $$;
 ALTER TABLE task_thread_messages ALTER COLUMN message_id SET DEFAULT thread_test_uuid()`)
	var message model.ThreadMessage
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		if _, err := tx.LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		var stamp time.Time
		if err := tx.tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())+interval '30 milliseconds'`).Scan(&stamp); err != nil {
			return err
		}
		head := &model.ThreadPosition{CreatedAt: stamp.UTC(), ID: "ffffffff-ffff-4fff-8fff-ffffffffffff"}
		if err := tx.AdvanceHead(ctx, queryID(1), *head); err != nil {
			return err
		}
		var err error
		message, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "one UUID"})
		if err != nil {
			return err
		}
		id := message.ID
		if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		if message.ID != id || !message.CreatedAt.After(head.CreatedAt) {
			t.Fatalf("UUID regenerated or timestamp fabricated: %#v head=%#v", message, head)
		}
		return tx.AdvanceHead(ctx, queryID(1), message.Position())
	}); err != nil {
		t.Fatal(err)
	}
	var calls int
	if err := database.Pool.QueryRow(ctx, `SELECT last_value FROM thread_uuid_calls`).Scan(&calls); err != nil || calls != 1 || message.ID != queryID(1) {
		t.Fatalf("UUID generation count=%d id=%s %v", calls, message.ID, err)
	}
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		return tx.AdvanceHead(ctx, queryID(1), message.Position())
	}); err == nil {
		t.Fatal("head accepted non-forward update")
	}
}

func TestThreadClockExhaustionDoesNotPublishInsertedCandidate(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	var candidate model.ThreadMessage
	err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		if _, err := tx.LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		var err error
		candidate, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "must roll back"})
		if err != nil {
			return err
		}
		head := &model.ThreadPosition{CreatedAt: candidate.CreatedAt.Add(time.Hour), ID: queryID(1)}
		return tx.PrepareTimestamp(ctx, &candidate, head)
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
