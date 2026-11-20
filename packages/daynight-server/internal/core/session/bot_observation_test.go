package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func botObservationFixture() (*Engine, *store.BotSessionSource, *liveSession) {
	now := time.Date(2026, 11, 20, 9, 0, 0, 0, time.FixedZone("local", 8*60*60))
	engine := NewEngine(nil)
	engine.now = func() time.Time { return now }
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: "44444444-4444-4444-8444-444444444444", TestExecutionID: "55555555-5555-4555-8555-555555555555", ExecutionGeneration: "2"}, ConnectionEpoch: "3"}
	source := &store.BotSessionSource{Snapshot: sp.Snapshot{ControllerFence: fence}, ServerInstance: engine.instance}
	turn := "current-turn"
	live := newLive(sp.Snapshot{ControllerFence: fence, ConnectionState: "connected", Synchronized: true, Activity: "working", CurrentTurnID: &turn})
	live.Synced = true
	engine.live[fence.SessionID] = &liveCell{value: live}
	return engine, source, live
}

func TestBotObservationRequiresCurrentLocalFence(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Engine, **store.BotSessionSource, *liveSession)
	}{
		{name: "no source", change: func(_ *Engine, source **store.BotSessionSource, _ *liveSession) { *source = nil }},
		{name: "no live", change: func(engine *Engine, source **store.BotSessionSource, _ *liveSession) {
			delete(engine.live, (*source).Snapshot.SessionID)
		}},
		{name: "empty cell", change: func(engine *Engine, source **store.BotSessionSource, _ *liveSession) {
			engine.live[(*source).Snapshot.SessionID].value = nil
		}},
		{name: "other relay", change: func(_ *Engine, source **store.BotSessionSource, _ *liveSession) {
			(*source).ServerInstance = "other-relay"
		}},
		{name: "no relay", change: func(_ *Engine, source **store.BotSessionSource, _ *liveSession) { (*source).ServerInstance = "" }},
		{name: "old generation", change: func(_ *Engine, _ **store.BotSessionSource, live *liveSession) {
			live.Snapshot.ExecutionGeneration = "1"
		}},
		{name: "old connection epoch", change: func(_ *Engine, _ **store.BotSessionSource, live *liveSession) { live.Snapshot.ConnectionEpoch = "2" }},
		{name: "other execution", change: func(_ *Engine, _ **store.BotSessionSource, live *liveSession) {
			live.Snapshot.TestExecutionID = "66666666-6666-4666-8666-666666666666"
		}},
		{name: "other session", change: func(_ *Engine, _ **store.BotSessionSource, live *liveSession) {
			live.Snapshot.SessionID = "66666666-6666-4666-8666-666666666666"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine, source, live := botObservationFixture()
			test.change(engine, &source, live)
			got, err := engine.ObserveBotSession(t.Context(), source)
			want := store.BotSessionLive{ObservedAt: engine.now().UTC()}
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("unavailable source: %+v %v", got, err)
			}
		})
	}
}

func TestBotObservationCopiesOnlyCommittedDisplayScalars(t *testing.T) {
	engine, source, live := botObservationFixture()
	live.Snapshot.Identity.NativeSessionID = observationPointer("private-native-identity")
	live.Snapshot.Controls = &sp.Controls{}
	live.Commands["private-command"] = sp.Command{}
	before := cloneLive(live)
	got, err := engine.ObserveBotSession(t.Context(), source)
	if err != nil || !got.Available || got.Fence != source.Snapshot.ControllerFence || got.ConnectionState != "connected" || !got.Synchronized || !got.SourceSynced || got.Activity != "working" || got.CurrentTurnID == nil || *got.CurrentTurnID != "current-turn" {
		t.Fatalf("live source: %+v %v", got, err)
	}
	if !got.ObservedAt.Equal(engine.now()) || got.ObservedAt.Location() != time.UTC {
		t.Fatalf("observation clock: %v", got.ObservedAt)
	}
	encoded, err := json.Marshal(got)
	if err != nil || strings.Contains(string(encoded), "private-") || strings.Contains(string(encoded), "Controls") || strings.Contains(string(encoded), "CanSend") {
		t.Fatalf("display facts leaked Session content or permissions: %s %v", encoded, err)
	}
	*got.CurrentTurnID = "consumer-change"
	if !reflect.DeepEqual(live, before) {
		t.Fatal("observation mutated or aliased committed live state")
	}
	if source.Snapshot.Activity != "" || source.Snapshot.CurrentTurnID != nil {
		t.Fatal("observation changed the durable source")
	}

	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionCommitted} {
		op, err := engine.BeginOperation()
		if err != nil {
			t.Fatal(err)
		}
		draft, err := op.content(source.Snapshot.SessionID, false)
		if err != nil {
			op.Close()
			t.Fatal(err)
		}
		draft.Snapshot.Activity, draft.Snapshot.CurrentTurnID = "idle", nil
		draft.Synced = false
		op.Finish(outcome)
		got, err := engine.ObserveBotSession(t.Context(), source)
		want := "working"
		if outcome == store.TransactionCommitted {
			want = "idle"
		}
		if err != nil || !got.Available || got.Activity != want || got.SourceSynced != (outcome == store.TransactionNotCommitted) || (got.CurrentTurnID != nil) != (outcome == store.TransactionNotCommitted) {
			t.Fatalf("observation after %s: %+v %v", outcome, got, err)
		}
	}
}

func TestBotObservationLeavesReadinessAndFreshnessToTheCaller(t *testing.T) {
	engine, source, live := botObservationFixture()
	expired := engine.now().Add(-time.Hour)
	source.LastSeen, source.ConnectionExpiry = &expired, &expired
	source.Snapshot.Lifecycle = "archived"
	live.Snapshot.ConnectionState, live.Snapshot.Synchronized, live.Synced = "disconnected", false, false
	got, err := engine.ObserveBotSession(t.Context(), source)
	if err != nil || !got.Available || got.ConnectionState != "disconnected" || got.Synchronized || got.SourceSynced || got.Activity != "working" {
		t.Fatalf("raw committed facts: %+v %v", got, err)
	}
}

func TestBotObservationHonorsCancellationAndShutdown(t *testing.T) {
	for _, moment := range []string{"before", "after sample"} {
		for _, reason := range []string{"cancel", "shutdown"} {
			t.Run(moment+" "+reason, func(t *testing.T) {
				engine, source, _ := botObservationFixture()
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				stop := cancel
				if reason == "shutdown" {
					stop = engine.CancelWork
				}
				if moment == "before" {
					stop()
				} else {
					now := engine.now()
					engine.now = func() time.Time { stop(); return now }
				}
				got, err := engine.ObserveBotSession(ctx, source)
				if err == nil || reason == "cancel" && !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, store.BotSessionLive{}) {
					t.Fatalf("stopped observation: %+v %v", got, err)
				}
				if engine.activeOperations != 0 {
					t.Fatalf("retained operations: %d", engine.activeOperations)
				}
			})
		}
	}
	engine, source, _ := botObservationFixture()
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, err := engine.ObserveBotSession(t.Context(), source); err == nil || !reflect.DeepEqual(got, store.BotSessionLive{}) {
		t.Fatalf("closed admission: %+v %v", got, err)
	}
}
