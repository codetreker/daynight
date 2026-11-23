package bot_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func recoveryData() model.BotRecovery {
	return model.BotRecovery{ServiceOrigin: "https://daynight.example", MachineID: "original-machine", MachineName: "Original machine", IdentityHash: bytes.Repeat([]byte{7}, 32), HostingGeneration: 1}
}

func TestRecoveryRegistrationAndTakeoverPersistOnlyCurrentHostingChanges(t *testing.T) {
	f := newFixture(t)
	bot := f.ready(t, f.candidate)
	exec(t, f.tx, `UPDATE workers SET telemetry='{"machine":{"ID":"original-machine","Name":"Original machine"}}' WHERE worker_id=$1`, bot.WorkerID)
	machine, err := f.writer.RecoveryWorker(t.Context(), bot.OwnerUserID, bot.WorkerID)
	if err != nil || machine.ID != "original-machine" || machine.Name != "Original machine" {
		t.Fatalf("machine identity: %+v %v", machine, err)
	}
	registered, err := f.writer.RegisterBotRecovery(t.Context(), bot.ID, bot.Version, recoveryData())
	expectedRecovery := recoveryData()
	expectedRecovery.WorkerID = bot.WorkerID
	if err != nil || registered.Version != bot.Version+1 || !reflect.DeepEqual(registered.Recovery, ptrRecovery(expectedRecovery)) {
		t.Fatalf("registered state: %+v %v", registered, err)
	}
	worker := uuid.NewString()
	exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{"state":"unavailable","items":[]}')`, bot.OwnerUserID, worker)
	changed, err := f.writer.AdvanceBotRecovery(t.Context(), bot.ID, registered.Version, 1, worker, machine)
	if err != nil {
		t.Fatal(err)
	}
	if changed.WorkerID != bot.WorkerID || changed.Recovery.WorkerID != worker || changed.Version != registered.Version+1 || changed.Recovery.HostingGeneration != 2 || changed.StartupResult.State != "pending" || changed.StartupResult.Code != nil {
		t.Fatalf("hosting advance: %+v", changed)
	}
	if !reflect.DeepEqual(changed.SessionID, bot.SessionID) || !reflect.DeepEqual(changed.TestExecutionID, bot.TestExecutionID) || !reflect.DeepEqual(changed.ResolvedConfiguration, bot.ResolvedConfiguration) || !reflect.DeepEqual(changed.RoleConfiguration, bot.RoleConfiguration) || changed.RequestFingerprint != bot.RequestFingerprint {
		t.Fatal("takeover altered frozen creation or Session identity")
	}
	if _, err = f.writer.RegisterBotRecovery(t.Context(), bot.ID, changed.Version, recoveryData()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("second registration replaced recovery proof: %v", err)
	}
	for _, pair := range [][2]int64{{changed.Version - 1, 2}, {changed.Version, 1}} {
		if _, err = f.writer.AdvanceBotRecovery(t.Context(), bot.ID, pair[0], pair[1], bot.WorkerID, machine); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("stale version/generation accepted: %v", err)
		}
	}
	readback, err := f.reader.Bot(t.Context(), bot.ID)
	if err != nil || !reflect.DeepEqual(readback, changed) {
		t.Fatalf("stale writes changed persisted state: %+v %v", readback, err)
	}
}

func ptrRecovery(value model.BotRecovery) *model.BotRecovery { return &value }

func TestRecoveryRegistrationAndAdvanceRejectMissingDeletedOrExhaustedRows(t *testing.T) {
	for _, condition := range []string{"unbound", "deleted", "exhausted", "stale"} {
		t.Run(condition, func(t *testing.T) {
			f := newFixture(t)
			bot := f.insert(t, f.candidate)
			if condition != "unbound" {
				sessionID, executionID := uuid.NewString(), uuid.NewString()
				if err := insertBotSession(t.Context(), f.tx, bot, sessionID, executionID); err != nil {
					t.Fatal(err)
				}
				var err error
				bot, err = f.writer.BindBotSession(t.Context(), bot.ID, bot.Version, sessionID, model.BotRoleConfiguration{})
				if err != nil {
					t.Fatal(err)
				}
			}
			switch condition {
			case "deleted":
				exec(t, f.tx, `UPDATE bots SET deletion='{}' WHERE id=$1`, bot.ID)
			case "exhausted":
				bot.Version = math.MaxInt64
				exec(t, f.tx, `UPDATE bots SET version=$2 WHERE id=$1`, bot.ID, bot.Version)
			case "stale":
				bot.Version--
			}
			if _, err := f.writer.RegisterBotRecovery(t.Context(), bot.ID, bot.Version, recoveryData()); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("registration accepted %s: %v", condition, err)
			}
			if _, err := f.writer.AdvanceBotRecovery(t.Context(), bot.ID, bot.Version, 1, bot.WorkerID, model.WorkerMachine{ID: "original-machine"}); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("advance accepted %s: %v", condition, err)
			}
		})
	}
}

func boundRecoveryBot(t *testing.T, database *postgres.Store) model.Bot {
	t.Helper()
	bot := runtimeStoredBot(t, database)
	if err := writeBotWithSessionTest(database, t.Context(), func(dao store.BotWriteDAO, raw pgx.Tx) error {
		sessionID, executionID := uuid.NewString(), uuid.NewString()
		if err := insertBotSession(t.Context(), raw, bot, sessionID, executionID); err != nil {
			return err
		}
		var err error
		bot, err = dao.BindBotSession(t.Context(), bot.ID, 1, sessionID, model.BotRoleConfiguration{})
		if err != nil {
			return err
		}
		bot, err = dao.RegisterBotRecovery(t.Context(), bot.ID, bot.Version, recoveryData())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return bot
}

func TestRecoveryOperationReceiptSurvivesCommittedUnobservedResponse(t *testing.T) {
	database := isolatedStore(t)
	bot := boundRecoveryBot(t, database)
	operation := store.BotRecoveryOperation{OperationID: uuid.NewString(), Kind: "takeover", RequestHash: bytes.Repeat([]byte{3}, 32), Receipt: json.RawMessage(`{"hostingGeneration":"2","sessionId":"original"}`)}
	if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error {
		if _, err := dao.Bot(t.Context(), bot.ID); err != nil {
			return err
		}
		if _, err := dao.AdvanceBotRecovery(t.Context(), bot.ID, bot.Version, 1, bot.WorkerID, model.WorkerMachine{ID: "original-machine", Name: "Renamed"}); err != nil {
			return err
		}
		return dao.SaveBotRecoveryOperation(t.Context(), bot.ID, operation)
	}); err != nil {
		t.Fatal(err)
	}
	// A fresh transaction recovers the committed receipt without repeating a grant
	// or advancing the generation, even if the writer discarded its response.
	for range 2 {
		if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error {
			got, err := dao.BotRecoveryOperation(t.Context(), bot.ID, operation.OperationID)
			if err != nil {
				return err
			}
			var receipt map[string]string
			if err := json.Unmarshal(got.Receipt, &receipt); err != nil {
				return err
			}
			if got.OperationID != operation.OperationID || got.Kind != operation.Kind || !bytes.Equal(got.RequestHash, operation.RequestHash) || receipt["hostingGeneration"] != "2" || receipt["sessionId"] != "original" {
				t.Fatalf("receipt changed: %+v", got)
			}
			current, err := dao.Bot(t.Context(), bot.ID)
			if err == nil && (current.Recovery.HostingGeneration != 2 || current.Version != bot.Version+1) {
				t.Fatal("receipt query mutated hosting")
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error {
		_, err := dao.BotRecoveryOperation(t.Context(), bot.ID, uuid.NewString())
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing operation: %v", err)
	}
	if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error { return dao.SaveBotRecoveryOperation(t.Context(), bot.ID, operation) }); err == nil {
		t.Fatal("duplicate operation replaced receipt")
	}
}

func TestRecoveryFailedTransactionRollsBackHostingAndReceiptTogether(t *testing.T) {
	database := isolatedStore(t)
	bot := boundRecoveryBot(t, database)
	operation := store.BotRecoveryOperation{OperationID: uuid.NewString(), Kind: "takeover", RequestHash: make([]byte, 32), Receipt: json.RawMessage(`{}`)}
	failure := errors.New("Session authorization failed")
	if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error {
		if _, err := dao.Bot(t.Context(), bot.ID); err != nil {
			return err
		}
		if _, err := dao.AdvanceBotRecovery(t.Context(), bot.ID, bot.Version, 1, bot.WorkerID, model.WorkerMachine{ID: "original-machine"}); err != nil {
			return err
		}
		if err := dao.SaveBotRecoveryOperation(t.Context(), bot.ID, operation); err != nil {
			return err
		}
		return failure
	}); !errors.Is(err, failure) {
		t.Fatalf("rollback outcome: %v", err)
	}
	if err := writeBotTest(database, t.Context(), func(dao store.BotWriteDAO) error {
		current, err := dao.Bot(t.Context(), bot.ID)
		if err != nil {
			return err
		}
		if current.Version != bot.Version || current.Recovery.HostingGeneration != 1 {
			t.Fatal("failed Session transition advanced hosting")
		}
		_, err = dao.BotRecoveryOperation(t.Context(), bot.ID, operation.OperationID)
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("rolled back receipt exists: %v", err)
	}
}

func TestRecoveryTwoCandidatesCannotAcquireTheSameGeneration(t *testing.T) {
	database := isolatedStore(t)
	bot := boundRecoveryBot(t, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	winner, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer winner.Rollback(context.Background())
	first := botpg.NewWriter(winner)
	if _, err := first.Bot(ctx, bot.ID); err != nil {
		t.Fatal(err)
	}
	loser, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer loser.Rollback(context.Background())
	var pid int
	if err := loser.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		second := botpg.NewWriter(loser)
		if _, err := second.Bot(ctx, bot.ID); err != nil {
			done <- err
			return
		}
		_, err := second.AdvanceBotRecovery(ctx, bot.ID, bot.Version, 1, bot.WorkerID, model.WorkerMachine{ID: "original-machine"})
		done <- err
	}()
	defer func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("recovery contender did not exit after cancellation")
		}
	}()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')", pid).Scan(&waiting); err != nil {
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
	if _, err := first.AdvanceBotRecovery(ctx, bot.ID, bot.Version, 1, bot.WorkerID, model.WorkerMachine{ID: "original-machine"}); err != nil {
		t.Fatal(err)
	}
	if err := winner.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("second candidate acquired consumed generation: %v", err)
	}
}

func TestRecoveryStoragePropagatesClosedTransactionAndMissingWorker(t *testing.T) {
	f := newFixture(t)
	if _, err := f.writer.RecoveryWorker(t.Context(), f.candidate.OwnerUserID, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing worker: %v", err)
	}
	if err := f.tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.writer.RecoveryWorker(t.Context(), f.candidate.OwnerUserID, f.candidate.WorkerID); err == nil {
		t.Fatal("closed machine read succeeded")
	}
	if _, err := f.writer.RegisterBotRecovery(t.Context(), f.candidate.ID, 1, recoveryData()); err == nil {
		t.Fatal("closed registration succeeded")
	}
	if _, err := f.writer.AdvanceBotRecovery(t.Context(), f.candidate.ID, 1, 1, f.candidate.WorkerID, model.WorkerMachine{}); err == nil {
		t.Fatal("closed takeover succeeded")
	}
	if _, err := f.writer.BotRecoveryOperation(t.Context(), f.candidate.ID, uuid.NewString()); err == nil {
		t.Fatal("closed receipt read succeeded")
	}
	if _, err := f.writer.BotRecoveryTokenUsed(t.Context(), f.candidate.ID, "hash"); err == nil {
		t.Fatal("closed token history read succeeded")
	}
	if err := f.writer.SaveBotRecoveryOperation(t.Context(), f.candidate.ID, store.BotRecoveryOperation{}); err == nil {
		t.Fatal("closed receipt write succeeded")
	}
}

func TestRecoveryTokenHistoryRetainsEarlierTokensAndBotScope(t *testing.T) {
	f := newFixture(t)
	bot := f.ready(t, f.candidate)
	for _, tokenHash := range []string{"first", "second"} {
		body, err := json.Marshal(map[string]string{"controllerTokenHash": tokenHash})
		if err != nil {
			t.Fatal(err)
		}
		if err := f.writer.SaveBotRecoveryOperation(t.Context(), bot.ID, store.BotRecoveryOperation{OperationID: uuid.NewString(), Kind: "grant", RequestHash: make([]byte, 32), Receipt: body}); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		bot, hash string
		used      bool
	}{
		{bot.ID, "first", true}, {bot.ID, "second", true}, {bot.ID, "new", false}, {uuid.NewString(), "first", false},
	} {
		got, err := f.writer.BotRecoveryTokenUsed(t.Context(), test.bot, test.hash)
		if err != nil || got != test.used {
			t.Fatalf("token history for %s/%s: %t %v", test.bot, test.hash, got, err)
		}
	}
}
