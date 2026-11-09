package bot_test

import (
	"context"
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"math"
	"testing"
	"time"
)

func TestBotLockedReadObservesCompleteConcurrentBinding(t *testing.T) {
	db := isolatedStore(t)
	bot := runtimeStoredBot(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err = botpg.NewWriter(writer).Bot(ctx, bot.ID); err != nil {
		t.Fatal(err)
	}
	sid, eid := uuid.NewString(), uuid.NewString()
	if err = insertBotSession(ctx, writer, bot, sid, eid); err != nil {
		t.Fatal(err)
	}
	if _, err = botpg.NewWriter(writer).BindBotSession(ctx, bot.ID, 1, sid, model.BotRoleConfiguration{Instructions: "role", Revision: "1", Digest: "digest"}); err != nil {
		t.Fatal(err)
	}
	reader, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback(context.Background())
	var pid int
	if err = reader.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	type result struct {
		bot model.Bot
		err error
	}
	done := make(chan result, 1)
	go func() { b, e := botpg.NewWriter(reader).Bot(ctx, bot.ID); done <- result{b, e} }()
	for {
		var waiting bool
		if err = db.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')", pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.bot.Version != 2 || got.bot.SessionID == nil || *got.bot.SessionID != sid || got.bot.TestExecutionID == nil || *got.bot.TestExecutionID != eid {
		t.Fatalf("waiting reader returned an incomplete binding: %+v", got.bot)
	}
}

func TestBotStartupRejectsUnboundStaleDeletedAndExhaustedWrites(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "ready"})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unbound Bot became ready: %v", err)
	}
	code := "directory_missing"
	principal := runtimeBotPAT(t, database, bot)
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, true, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed", Code: &code})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("report credential expired behind unchanged Bot lock: %v", err)
	}
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, false, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
		current, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed", Code: &code})
		if err == nil && (current.Version != 2 || current.StartupResult.State != "failed" || current.StartupResult.Code == nil || *current.StartupResult.Code != code) {
			return fmt.Errorf("failure result was lost: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	beforeReplay := runtimeBotState(t, database, bot.ID)
	for _, expired := range []bool{true, false} {
		err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, expired, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
			current, err := tx.Bot(ctx, bot.ID)
			if err == nil && (current.Version != 2 || current.StartupResult.State != "failed" || current.StartupResult.Code == nil || *current.StartupResult.Code != code || current.SessionID != nil || current.RoleConfiguration != nil) {
				t.Error("report read lost committed preflight result")
			}
			return err
		})
		if expired && !errors.Is(err, model.ErrNotFound) || !expired && err != nil || runtimeBotState(t, database, bot.ID) != beforeReplay {
			t.Fatalf("report replay changed state or credential outcome: expired=%t error=%v", expired, err)
		}
	}
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "pending"})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("stale startup write succeeded: %v", err)
	}
	for _, state := range []string{"deleted", "exhausted"} {
		t.Run(state, func(t *testing.T) {
			candidate := runtimeStoredBot(t, database)
			version := int64(1)
			if state == "deleted" {
				mustQueryExec(t, database, `UPDATE bots SET deletion='{}' WHERE id=$1`, candidate.ID)
			} else {
				version = math.MaxInt64
				mustQueryExec(t, database, `UPDATE bots SET version=$2 WHERE id=$1`, candidate.ID, version)
			}
			if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
				_, err := tx.SetBotStartup(ctx, candidate.ID, version, model.BotStartupResult{State: "failed", Code: &code})
				return err
			}); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("invalid startup update: %v", err)
			}
		})
	}
}

func TestBotSessionConstraintsRejectCrossOwnerAndDuplicateBinding(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := writeBotWithSessionTest(database, ctx, func(_ BotWriteDAO, raw pgx.Tx) error {
		return insertBotSession(ctx, raw, bot, uuid.NewString(), uuid.NewString())
	}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		name, code string
		candidate  model.Bot
	}{
		{"duplicate", "23505", bot},
		{"cross_owner", "23503", model.Bot{ID: bot.ID, OwnerUserID: uuid.NewString()}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			if entry.name == "cross_owner" {
				mustQueryExec(t, database, `DELETE FROM task_sessions WHERE bot_id=$1`, bot.ID)
			}
			err := writeBotWithSessionTest(database, ctx, func(_ BotWriteDAO, raw pgx.Tx) error {
				return insertBotSession(ctx, raw, entry.candidate, uuid.NewString(), uuid.NewString())
			})
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != entry.code {
				t.Fatalf("invalid binding accepted: %v", err)
			}
		})
	}
}

func TestBotSessionConstraintKeepsTasksSeparate(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	for _, backend := range []string{"web", "herdr"} {
		t.Run(backend, func(t *testing.T) {
			snapshot, terminal := any(`{}`), any(nil)
			if backend == "herdr" {
				snapshot, terminal = nil, `{}`
			}
			_, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,bot_id)
 VALUES($1,'task',$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10)`, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), bot.OwnerUserID, uuid.NewString(), snapshot, backend, terminal, bot.ID)
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != "23514" || postgres.ConstraintName != "session_bot_scope" {
				t.Fatalf("task accepted a Bot binding: %v", err)
			}
		})
	}
}

func TestBotRuntimeStorageFailuresAreNotSuccessfulWrites(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := botpg.NewWriter(tx).Bot(ctx, bot.ID); return err },
		func() error {
			_, err := botpg.NewWriter(tx).BindBotSession(ctx, bot.ID, 1, uuid.NewString(), model.BotRoleConfiguration{})
			return err
		},
		func() error {
			_, err := botpg.NewWriter(tx).SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed"})
			return err
		},
	} {
		if err := operation(); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("closed transaction became a success or business refusal: %v", err)
		}
	}
}

func TestBotStorageFailuresRemainErrors(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	ctx := context.Background()
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, candidate) }); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE bots SET requested_overrides='{"workerId":42}' WHERE id=$1`, candidate.ID); err != nil {
		t.Fatal(err)
	}
	for _, read := range []func(SnapshotScope) error{
		func(snapshot SnapshotScope) error { _, err := snapshot.BotDAO().Bot(ctx, candidate.ID); return err },
		func(snapshot SnapshotScope) error {
			_, err := snapshot.BotDAO().Bots(ctx, candidate.OwnerUserID, nil, Page{Limit: 10})
			return err
		},
	} {
		if err := database.ReadSnapshot(ctx, read); err == nil || errors.Is(err, model.ErrNotFound) {
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
	closed := botpg.NewWriter(tx)
	snapshot := botpg.NewReader(tx)
	for _, operation := range []func() error{
		func() error { return closed.Credential(ctx, model.Principal{Kind: model.SessionCredential}) },
		func() error { return closed.Credential(ctx, model.Principal{Kind: "unknown"}) },
		func() error { return closed.Worker(ctx, candidate.OwnerUserID, candidate.WorkerID) },
		func() error { _, err := closed.Bot(ctx, candidate.ID); return err },
		func() error { return closed.InsertBot(ctx, candidate) },
		func() error { _, err := closed.SaveBotDeletion(ctx, candidate.ID, &model.BotDeletion{}); return err },
		func() error { _, err := snapshot.Bot(ctx, candidate.ID); return err },
		func() error { return snapshot.BotWorker(ctx, candidate.OwnerUserID, candidate.WorkerID) },
		func() error {
			_, err := snapshot.Bots(ctx, candidate.OwnerUserID, nil, Page{Limit: 10})
			return err
		},
	} {
		if err := operation(); err == nil {
			t.Fatal("closed transaction appeared successful")
		}
	}
}

func TestBotStorageDeletionAndScopedPagination(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	candidate, principal := storedBotCandidate(t, database)
	workerID := candidate.WorkerID
	ids := make(map[string]bool)
	for range 3 {
		candidate.ID = uuid.NewString()
		ids[candidate.ID] = true
		if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, candidate) }); err != nil {
			t.Fatal(err)
		}
	}
	secondWorker := uuid.NewString()
	putWorkerSnapshot(t, database, workerSnapshotFixture(principal.UserID, secondWorker, time.Now().UTC()))
	otherWorkerBot := candidate
	otherWorkerBot.ID, otherWorkerBot.WorkerID = uuid.NewString(), secondWorker
	otherWorkerBot.ResolvedConfiguration.WorkerID = secondWorker
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, otherWorkerBot) }); err != nil {
		t.Fatal(err)
	}
	_, otherPrincipal, _ := testAuthRecords(t, database)
	putWorkerSnapshot(t, database, workerSnapshotFixture(otherPrincipal.UserID, workerID, time.Now().UTC()))
	foreignBot := candidate
	foreignBot.ID, foreignBot.OwnerUserID = uuid.NewString(), otherPrincipal.UserID
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, foreignBot) }); err != nil {
		t.Fatal(err)
	}
	readPage := func(ownerID string, workerID *string, page Page) BotPage {
		t.Helper()
		var result BotPage
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			result, err = snapshot.BotDAO().Bots(ctx, ownerID, workerID, page)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	page := readPage(principal.UserID, &workerID, Page{Limit: 2})
	if len(page.Items) != 2 || !page.HasMore {
		t.Fatalf("worker first page: %+v", page)
	}
	seen := make(map[string]bool)
	for _, bot := range page.Items {
		if !ids[bot.ID] || bot.OwnerUserID != principal.UserID || bot.WorkerID != workerID {
			t.Fatalf("first page leaked another owner or Worker: %+v", bot)
		}
		seen[bot.ID] = true
	}
	last := page.Items[len(page.Items)-1]
	tail := readPage(principal.UserID, &workerID, Page{Limit: 2, After: &Position{CreatedAt: last.CreatedAt, ID: last.ID}})
	if len(tail.Items) != 1 || tail.HasMore || !ids[tail.Items[0].ID] || seen[tail.Items[0].ID] {
		t.Fatalf("worker tail repeated or lost a definition: %+v", tail)
	}
	page = readPage(principal.UserID, nil, Page{Limit: 10})
	if len(page.Items) != 4 || page.HasMore {
		t.Fatalf("owner list excluded its other Worker: %+v", page)
	}
	page = readPage(otherPrincipal.UserID, &workerID, Page{Limit: 10})
	if len(page.Items) != 1 || page.Items[0].ID != foreignBot.ID || page.HasMore {
		t.Fatalf("same Worker UUID crossed owner scope: %+v", page)
	}
	page = readPage(principal.UserID, &secondWorker, Page{Limit: 10})
	if len(page.Items) != 1 || page.Items[0].ID != otherWorkerBot.ID {
		t.Fatalf("other Worker scope: %+v", page)
	}
	deletion := model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	var deleted model.Bot
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		current, err := tx.Bot(ctx, candidate.ID)
		if err != nil {
			return err
		}
		deleted, err = tx.SaveBotDeletion(ctx, current.ID, &deletion)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if deleted.ID != candidate.ID || deleted.Version != 2 || deleted.Deletion == nil || *deleted.Deletion != deletion || deleted.WorkerID != workerID {
		t.Fatalf("deletion lost the original identity or obligation: %+v", deleted)
	}
	page = readPage(principal.UserID, nil, Page{Limit: 10})
	if len(page.Items) != 3 {
		t.Fatalf("ordinary list did not hide deletion: %+v", page)
	}
	for _, bot := range page.Items {
		if bot.ID == deleted.ID || bot.Deletion != nil {
			t.Fatal("ordinary list included a deletion obligation")
		}
	}
	page = readPage(principal.UserID, &workerID, Page{Limit: 10})
	if len(page.Items) != 3 {
		t.Fatalf("Worker lost its pending cleanup responsibility: %+v", page)
	}
	foundDeletion := false
	for _, bot := range page.Items {
		if bot.ID == deleted.ID {
			foundDeletion = bot.Version == 2 && bot.Deletion != nil && *bot.Deletion == deletion
		}
	}
	if !foundDeletion {
		t.Fatal("Worker inventory changed the pending deletion result")
	}
}
