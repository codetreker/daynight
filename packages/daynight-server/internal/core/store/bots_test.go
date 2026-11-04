package store

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"strings"
	"testing"
	"time"
)

func TestBotDefinitionsHaveNoProjectDependency(t *testing.T) {
	database := isolatedStore(t)
	var exists bool
	if err := database.Pool.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='bots')`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("Bot definitions have no durable store")
	}
	var projectColumns int
	if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='bots' AND column_name='project_id'`).Scan(&projectColumns); err != nil {
		t.Fatal(err)
	}
	if projectColumns != 0 {
		t.Fatal("Bot definitions must not require a project")
	}
}

func storedBotCandidate(t *testing.T, database *Store) (core.Bot, core.Principal) {
	t.Helper()
	_, principal, _ := testAuthRecords(t, database)
	workerID := uuid.NewString()
	putWorkerSnapshot(t, database, workerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
	return core.Bot{ID: uuid.NewString(), OwnerUserID: principal.UserID, WorkerID: workerID, Name: "Stored Bot",
		RequestFingerprint: strings.Repeat("a", 64), ResolvedConfiguration: core.BotConfiguration{WorkerID: workerID, Cwd: "/ordinary", Provider: "codex", Args: []string{}}}, principal
}

func TestBotTransactionRollbackAndCompositeWorkerForeignKey(t *testing.T) {
	database := isolatedStore(t)
	candidate, principal := storedBotCandidate(t, database)
	ctx := context.Background()
	failure := errors.New("cancel the definition after insertion")
	err := database.WriteBot(ctx, func(tx *BotTx) error {
		if err := tx.Credential(ctx, principal); err != nil {
			return err
		}
		if err := tx.Worker(ctx, principal.UserID, candidate.WorkerID); err != nil {
			return err
		}
		if err := tx.InsertBot(ctx, candidate); err != nil {
			return err
		}
		if _, err := tx.Bot(ctx, candidate.ID); err != nil {
			return err
		}
		return failure
	})
	var transaction *TransactionError
	if !errors.Is(err, failure) || !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback outcome: %v", err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot *Snapshot) error { _, err := snapshot.Bot(ctx, candidate.ID); return err })
	if !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("rolled back Bot remained: %v", err)
	}
	other, _, _ := testAuthRecords(t, database)
	candidate.OwnerUserID = other.ID
	err = database.WriteBot(ctx, func(tx *BotTx) error { return tx.InsertBot(ctx, candidate) })
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23503" {
		t.Fatalf("cross-owner Worker accepted: %v", err)
	}
	candidate.OwnerUserID = principal.UserID
	if err := database.WriteBot(ctx, func(tx *BotTx) error { return tx.InsertBot(ctx, candidate) }); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, database.Pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		bot, err := snapshot.Bot(ctx, candidate.ID)
		if err == nil && (bot.Version != 1 || bot.CreationOrder < 1 || bot.CreatedAt.IsZero() || !bot.CreatedAt.Equal(bot.UpdatedAt)) {
			t.Fatalf("invalid committed definition: %+v", bot)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotStorageFailuresRemainErrors(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	ctx := context.Background()
	if err := database.WriteBot(ctx, func(tx *BotTx) error { return tx.InsertBot(ctx, candidate) }); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE bots SET requested_overrides='{"workerId":42}' WHERE id=$1`, candidate.ID); err != nil {
		t.Fatal(err)
	}
	for _, read := range []func(*Snapshot) error{
		func(snapshot *Snapshot) error { _, err := snapshot.Bot(ctx, candidate.ID); return err },
		func(snapshot *Snapshot) error {
			_, err := snapshot.Bots(ctx, candidate.OwnerUserID, nil, Page{Limit: 10})
			return err
		},
	} {
		if err := database.ReadSnapshot(ctx, read); err == nil || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("corrupt Bot was an empty read: %v", err)
		}
	}
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	closed := &BotTx{tx: tx}
	snapshot := &Snapshot{tx: tx}
	for _, operation := range []func() error{
		func() error { return closed.Credential(ctx, core.Principal{Kind: core.SessionCredential}) },
		func() error { return closed.Credential(ctx, core.Principal{Kind: "unknown"}) },
		func() error { return closed.Worker(ctx, candidate.OwnerUserID, candidate.WorkerID) },
		func() error { _, err := closed.Bot(ctx, candidate.ID); return err },
		func() error { return closed.InsertBot(ctx, candidate) },
		func() error { _, err := closed.DeleteBot(ctx, candidate.ID, 1, core.BotDeletion{}); return err },
		func() error { _, err := snapshot.Bot(ctx, candidate.ID); return err },
		func() error { return snapshot.BotWorker(ctx, candidate.OwnerUserID, candidate.WorkerID) },
		func() error { _, err := snapshot.Bots(ctx, candidate.OwnerUserID, nil, Page{Limit: 10}); return err },
	} {
		if err := operation(); err == nil {
			t.Fatal("closed transaction appeared successful")
		}
	}
	database.Close()
	if err := database.WriteBot(ctx, func(*BotTx) error { t.Fatal("closed pool invoked callback"); return nil }); err == nil {
		t.Fatal("closed pool appeared writable")
	}
}
