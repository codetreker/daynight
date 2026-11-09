package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

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
