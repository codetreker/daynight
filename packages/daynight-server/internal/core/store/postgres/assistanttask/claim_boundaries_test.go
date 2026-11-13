package assistanttask_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func asyncDatabase(t *testing.T, parent context.Context, fn func(context.Context) error) <-chan error {
	t.Helper()
	ctx, cancel := context.WithCancel(parent)
	result := make(chan error, 1)
	done := make(chan struct{})
	go func() { defer close(done); result <- fn(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("database operation did not drain")
		}
	})
	return result
}

func rollbackDatabase(t *testing.T, tx pgx.Tx) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback cleanup: %v", err)
		}
	})
}

func TestOnlyOneConcurrentPendingBindingCommits(t *testing.T) {
	f := setup(t)
	bot, _ := f.bot(t)
	f.task.HolderBotID = &bot
	f.task.ClaimGeneration = 2
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, first)
	firstToken, secondToken := "first token hash", "second token hash"
	candidate := f.task
	candidate.Version = 2
	candidate.ClaimTokenHash = &firstToken
	condition := store.AssistantTaskCondition{Version: 1, CheckClaim: true, Generation: 2, HolderBotID: &bot}
	if ok, err := assistanttask.New(first).SaveTask(ctx, candidate, condition); err != nil || !ok {
		t.Fatalf("first binding: %v %v", ok, err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			other := candidate
			other.ClaimTokenHash = &secondToken
			ok, err := s.AssistantTaskDAO().SaveTask(ctx, other, condition)
			if err != nil {
				return err
			}
			if ok {
				return errors.New("two bindings committed")
			}
			return nil
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err == nil && (got.ClaimGeneration != 2 || got.ClaimTokenHash == nil || *got.ClaimTokenHash != firstToken) {
			return fmt.Errorf("binding winner lost: %#v", got)
		}
		return err
	})
}

func TestTakeoverInvalidatesOldTokenAndGeneration(t *testing.T) {
	f := setup(t)
	oldBot, _ := f.bot(t)
	newBot, _ := f.bot(t)
	oldToken, newToken := "old hash", "new hash"
	expired := time.Now().UTC().Add(-time.Minute)
	f.task.HolderBotID = &oldBot
	f.task.ClaimTokenHash = &oldToken
	f.task.ClaimGeneration = 1
	f.task.LeaseUntil = &expired
	f.create(t)
	ctx := t.Context()
	candidate := f.task
	f.write(t, func(d store.AssistantTaskDAO) error {
		locked, err := d.Task(ctx, f.owner, f.task.ID, true)
		if err != nil {
			return err
		}
		now, err := d.Now(ctx)
		if err != nil {
			return err
		}
		if !locked.LeaseUntil.Before(now) {
			return errors.New("fixture lease did not expire")
		}
		lease := now.Add(5 * time.Minute)
		candidate.Version = 2
		candidate.ClaimGeneration = 2
		candidate.HolderBotID = &newBot
		candidate.ClaimTokenHash = &newToken
		candidate.LeaseUntil = &lease
		ok, err := d.SaveTask(ctx, candidate, store.AssistantTaskCondition{Version: 1, CheckClaim: true, Generation: 1, HolderBotID: &oldBot, TokenHash: &oldToken})
		if err == nil && !ok {
			return errors.New("takeover refused")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, condition := range []store.AssistantTaskCondition{
			{CheckClaim: true, LiveClaim: true, Generation: 1, HolderBotID: &oldBot, TokenHash: &oldToken},
			{CheckClaim: true, LiveClaim: true, Generation: 2, HolderBotID: &newBot, TokenHash: &oldToken},
			{CheckClaim: true, LiveClaim: true, Generation: 1, HolderBotID: &newBot, TokenHash: &newToken},
		} {
			ok, err := d.SaveTask(ctx, candidate, condition)
			if err != nil {
				return err
			}
			if ok {
				return errors.New("stale claim authorized a protected write")
			}
		}
		candidate.Version = 3
		candidate.Name = "new holder write"
		ok, err := d.SaveTask(ctx, candidate, store.AssistantTaskCondition{Version: 2, CheckClaim: true, LiveClaim: true, Generation: 2, HolderBotID: &newBot, TokenHash: &newToken})
		if err == nil && !ok {
			return errors.New("current holder refused")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err == nil && (got.Version != 3 || got.Name != "new holder write") {
			return errors.New("protected write did not persist")
		}
		return err
	})
}

func TestBotShareBarrierBlocksDeletionUntilTaskCompletes(t *testing.T) {
	f := setup(t)
	bot, principal := f.bot(t)
	f.task.HolderBotID = &bot
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, tx)
	d := assistanttask.New(tx)
	if err := d.Credential(ctx, principal); err != nil {
		t.Fatal(err)
	}
	got, err := d.Bot(ctx, bot)
	if err != nil || got.ID != bot {
		t.Fatalf("Bot barrier: %#v %v", got, err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.Pool.Exec(ctx, `DELETE FROM bots WHERE id=$1`, bot)
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "DELETE FROM bots")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(ctx, f.owner, f.task.ID, false)
		if err == nil && !got.HolderDeleted {
			return errors.New("committed holder deletion was not projected")
		}
		return err
	})
}

func TestBotProjectionRefreshesAfterLockWait(t *testing.T) {
	f := setup(t)
	bot, _ := f.bot(t)
	f.task.HolderBotID = &bot
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, tx)
	if _, err := tx.Exec(ctx, `UPDATE bots SET deletion='{}' WHERE id=$1`, bot); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			got, err := s.AssistantTaskDAO().Bot(ctx, bot)
			if err == nil && got.Deletion == nil {
				return errors.New("Bot projection hid committed deletion")
			}
			return err
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM bots")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
}

func TestTaskProjectionSeesHolderDeletionCommittedDuringLockWait(t *testing.T) {
	f := setup(t)
	bot, _ := f.bot(t)
	f.task.HolderBotID = &bot
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, tx)
	if _, err := tx.Exec(ctx, `SELECT id FROM assistant_tasks WHERE id=$1 FOR UPDATE`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			got, err := s.AssistantTaskDAO().Task(ctx, f.owner, f.task.ID, true)
			if err == nil && !got.HolderDeleted {
				return errors.New("task projection used pre-wait holder snapshot")
			}
			return err
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	if _, err := f.db.Pool.Exec(ctx, `UPDATE bots SET deletion='{}' WHERE id=$1`, bot); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
}

func TestTaskLockCancellationReleasesTransactionResources(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	tx, err := f.db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, tx)
	if _, err := tx.Exec(t.Context(), `SELECT id FROM assistant_tasks WHERE id=$1 FOR UPDATE`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		completion, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			_, err := s.AssistantTaskDAO().Task(ctx, f.owner, f.task.ID, true)
			return err
		})
		var failure *store.TransactionError
		if !errors.As(err, &failure) || failure.CommitAttempted {
			return fmt.Errorf("cancellation lost transaction facts: %#v %w", completion, err)
		}
		switch completion.Outcome {
		case store.TransactionUnknown:
			if !failure.CleanupFailed || !errors.Is(err, pgconn.ErrConnClosed) {
				return fmt.Errorf("unknown without closed cleanup: %#v %w", failure, err)
			}
		case store.TransactionNotCommitted:
			if failure.CleanupFailed {
				return fmt.Errorf("failed cleanup claimed rollback: %#v %w", failure, err)
			}
		default:
			return fmt.Errorf("cancelled lock wait reported success: %#v %w", completion, err)
		}
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
	cancel()
	if err := testutil.ReceiveQueryResult(t, t.Context(), result); !errors.Is(err, context.Canceled) {
		t.Fatalf("lock cancellation cause lost: %v", err)
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.Ping(t.Context()); err != nil {
		t.Fatalf("pool not reusable: %v", err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(t.Context(), f.owner, f.task.ID, true)
		if err == nil && got.Version != 1 {
			return errors.New("cancelled lock wait changed task")
		}
		return err
	})
}
