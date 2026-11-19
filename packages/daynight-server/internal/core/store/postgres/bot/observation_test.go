package bot_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func TestBotObservation(t *testing.T) {
	database := openFixtureStore(t)
	t.Run("session identity and lease", func(t *testing.T) { testBotObservationSession(t, database) })
	t.Run("missing facts and ownership", func(t *testing.T) { testBotObservationMissing(t, database) })
	t.Run("failures", func(t *testing.T) { testBotObservationFailures(t, database) })
	// The shared fixture uses a fixed credential hash. Commit only after the
	// independent rollback fixtures have released it.
	t.Run("persistent location", func(t *testing.T) { testBotObservationLocation(t, database) })
}

func testBotObservationLocation(t *testing.T, database *postgres.Store) {
	f := newFixtureInStore(t, database)
	bot := f.ready(t, f.candidate)
	at := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	telemetry := model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: "original-machine", Name: "Original machine"}, Platform: model.PlatformWindows,
		AssistantHost: &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: at, DefaultProvider: "codex",
			Providers: []model.WorkerAssistantProvider{{Provider: "codex", Available: true, Args: []string{}}}},
	}
	data, err := json.Marshal(telemetry)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE workers SET last_seen_at=$2,telemetry=$3,
 task_snapshot='{"state":"observed","items":[{"phase":"executing","activity":"working"}]}' WHERE worker_id=$1`, bot.WorkerID, at, data)
	source, err := f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || source.Worker == nil || !source.Worker.LastReportedAt.Equal(at) || source.Worker.Telemetry.Machine != telemetry.Machine || source.Worker.Telemetry.Platform != model.PlatformWindows || !reflect.DeepEqual(source.Worker.Telemetry.AssistantHost, telemetry.AssistantHost) {
		t.Fatalf("persistent host: %+v %v", source.Worker, err)
	}
	if len(source.Worker.TaskSnapshot.Items) != 0 || source.Worker.TaskSnapshot.State != "" {
		t.Fatal("Bot observation loaded unrelated task activity")
	}
	registered, err := f.writer.RegisterBotRecovery(t.Context(), bot.ID, bot.Version, recoveryData())
	if err != nil {
		t.Fatal(err)
	}
	currentWorker := uuid.NewString()
	exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 VALUES($1,$2,$3,$3,$4,'{"state":"unavailable","items":[]}')`, bot.OwnerUserID, currentWorker, at, data)
	if _, err := f.writer.AdvanceBotRecovery(t.Context(), bot.ID, registered.Version, 1, currentWorker, telemetry.Machine); err != nil {
		t.Fatal(err)
	}
	telemetry.Machine.Name = "Renamed machine"
	data, err = json.Marshal(telemetry)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE workers SET telemetry=$2 WHERE worker_id=$1`, currentWorker, data)
	if err := f.tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	// A new snapshot must read the committed current host even when the original
	// creation Worker and the current Worker are both older than inventory expiry.
	if err := database.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		got, err := scope.BotDAO().BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
		if err == nil && (got.Worker == nil || got.Worker.WorkerID != currentWorker || got.Worker.UserID != bot.OwnerUserID || got.Worker.Telemetry.Machine != telemetry.Machine || !got.Worker.LastReportedAt.Equal(at)) {
			t.Fatalf("committed takeover location: %+v", got.Worker)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func testBotObservationSession(t *testing.T, database *postgres.Store) {
	f := newFixtureInStore(t, database)
	bot := f.ready(t, f.candidate)
	at := time.Date(2026, 11, 20, 5, 6, 7, 8000, time.UTC)
	expiry, instance := at.Add(30*time.Second), uuid.NewString()
	metadata := map[string]any{
		"sessionId": *bot.SessionID, "testExecutionId": *bot.TestExecutionID,
		"executionGeneration": "9223372036854775806", "connectionEpoch": "42", "lifecycle": "active",
		"identity": map[string]any{"ownerUserId": bot.OwnerUserID, "workerId": bot.WorkerID, "provider": "codex", "nativeSessionId": "native-original"},
		"activity": "working", "synchronized": true, "capabilities": map[string]any{"send": true}, "historyEpoch": "discard",
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE task_sessions SET snapshot=$2,last_seen=$3,connection_expires_at=$4,server_instance=$5 WHERE id=$1`, *bot.SessionID, data, at, expiry, instance)
	got, err := f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || got.Session == nil {
		t.Fatalf("session read: %+v %v", got, err)
	}
	session := got.Session
	view := session.Snapshot
	if view.SessionID != *bot.SessionID || view.TestExecutionID != *bot.TestExecutionID || view.ExecutionGeneration != "9223372036854775806" || view.ConnectionEpoch != "42" || view.Lifecycle != "active" || view.Identity.OwnerUserID != bot.OwnerUserID || view.Identity.WorkerID != bot.WorkerID || view.Identity.Provider != "codex" || view.Identity.NativeSessionID == nil || *view.Identity.NativeSessionID != "native-original" {
		t.Fatalf("durable session identity: %+v", view)
	}
	if session.LastSeen == nil || !session.LastSeen.Equal(at) || session.ConnectionExpiry == nil || !session.ConnectionExpiry.Equal(expiry) || session.ServerInstance != instance {
		t.Fatalf("lease mapping: %+v", session)
	}
	if view.Activity != "" || view.Synchronized || view.Capabilities.Send || view.HistoryEpoch != "" {
		t.Fatalf("loaded non-durable observation fields: %+v", view)
	}
	exec(t, f.tx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,nativeSessionId}','null'),
 last_seen=NULL,connection_expires_at=NULL,server_instance=NULL WHERE id=$1`, *bot.SessionID)
	got, err = f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || got.Session == nil || got.Session.Snapshot.Identity.NativeSessionID != nil || got.Session.LastSeen != nil || got.Session.ConnectionExpiry != nil || got.Session.ServerInstance != "" {
		t.Fatalf("unbound native ID and cleared lease: %+v %v", got.Session, err)
	}
	other := f.candidate
	other.ID = uuid.NewString()
	other = f.ready(t, other)
	exec(t, f.tx, `UPDATE bots SET session_id=NULL WHERE id=$1`, other.ID)
	exec(t, f.tx, `UPDATE bots SET session_id=$2 WHERE id=$1`, bot.ID, *other.SessionID)
	got, err = f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || got.Session != nil {
		t.Fatalf("cross-binding exposed Session: %+v %v", got.Session, err)
	}
}

func testBotObservationMissing(t *testing.T, database *postgres.Store) {
	f := newFixtureInStore(t, database)
	bot := f.insert(t, f.candidate)
	got, err := f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || got.Session != nil || got.Worker == nil {
		t.Fatalf("unbound Bot: %+v %v", got, err)
	}
	// The original creation Worker has a foreign key; a missing later host is
	// represented by the independent recovery binding.
	exec(t, f.tx, `INSERT INTO bot_recovery(bot_id,worker_id,service_origin,machine_id,machine_name,identity_hash,hosting_generation)
 VALUES($1,$2,'https://daynight.example','machine','Machine',$3,1)`, bot.ID, uuid.NewString(), make([]byte, 32))
	got, err = f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || got.Worker != nil || got.Session != nil {
		t.Fatalf("missing host: %+v %v", got, err)
	}
	for _, ids := range [][2]string{{uuid.NewString(), bot.ID}, {bot.OwnerUserID, uuid.NewString()}} {
		if _, err := f.reader.BotObservation(t.Context(), ids[0], ids[1]); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing or foreign Bot: %v", err)
		}
	}
	exec(t, f.tx, `UPDATE bots SET deletion='{}' WHERE id=$1`, bot.ID)
	if _, err := f.reader.BotObservation(t.Context(), bot.OwnerUserID, bot.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted Bot: %v", err)
	}
}

func testBotObservationFailures(t *testing.T, database *postgres.Store) {
	for _, kind := range []string{"worker", "session", "cancelled", "closed"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixtureInStore(t, database)
			bot := f.ready(t, f.candidate)
			ctx := t.Context()
			switch kind {
			case "worker":
				exec(t, f.tx, `UPDATE workers SET telemetry='{"machine":{"ID":17}}' WHERE worker_id=$1`, bot.WorkerID)
			case "session":
				exec(t, f.tx, `UPDATE task_sessions SET snapshot='{"executionGeneration":17}' WHERE id=$1`, *bot.SessionID)
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "closed":
				if err := f.tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
			}
			got, err := f.reader.BotObservation(ctx, bot.OwnerUserID, bot.ID)
			if err == nil || got.Worker != nil || got.Session != nil {
				t.Fatalf("%s returned partial success: %+v %v", kind, got, err)
			}
			if kind == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation: %v", err)
			}
		})
	}
}
