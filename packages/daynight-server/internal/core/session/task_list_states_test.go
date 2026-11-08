package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func taskListSource(now time.Time) (store.TaskSessionSource, *liveSession) {
	worker := &model.WorkerClaim{ClaimID: "11111111-1111-4111-8111-111111111111", WorkerID: "22222222-2222-4222-8222-222222222222", WorktreeID: "33333333-3333-4333-8333-333333333333", State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}
	state := &store.TaskSessionStateSource{SessionID: "44444444-4444-4444-8444-444444444444", ProjectID: "55555555-5555-4555-8555-555555555555", TaskID: "66666666-6666-4666-8666-666666666666", ClaimID: worker.ClaimID, Lifecycle: "active", LastSeen: &now}
	state.Fence = sp.ControllerFence{Fence: sp.Fence{SessionID: state.SessionID, ClaimID: worker.ClaimID, ExecutionGeneration: "2"}, ConnectionEpoch: "3"}
	state.Identity = sp.Identity{ProjectID: state.ProjectID, TaskID: state.TaskID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, AgentControlMode: "web"}
	live := newLive(sp.Snapshot{ControllerFence: state.Fence, Identity: state.Identity, Lifecycle: "active", ConnectionState: "connected", Synchronized: true, Activity: "working"})
	return store.TaskSessionSource{TaskID: state.TaskID, TaskStatus: model.TaskInProgress, Worker: worker, Session: state}, live
}

func TestTaskListSessionStatesPreserveCurrentProjection(t *testing.T) {
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name   string
		mutate func(*store.TaskSessionSource, **liveSession)
		want   string
	}{
		{name: "working", want: "working"},
		{name: "input", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Activity = "waiting_input" }, want: "notice"},
		{name: "idle", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Activity = "idle" }, want: "warning"},
		{name: "stopped", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Activity = "stopped" }, want: "warning"},
		{name: "initializing", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Activity = "initializing" }, want: "pending"},
		{name: "unsynchronized input", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			(*live).Snapshot.Activity = "waiting_input"
			(*live).Snapshot.Synchronized = false
		}, want: "pending"},
		{name: "connecting", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.ConnectionState = "connecting" }, want: "pending"},
		{name: "unknown connected", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Activity = "unknown" }},
		{name: "unknown connecting", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			(*live).Snapshot.Activity = "unknown"
			(*live).Snapshot.ConnectionState = "connecting"
		}},
		{name: "disconnected before sync", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			(*live).Snapshot.ConnectionState = "disconnected"
			(*live).Snapshot.Synchronized = false
		}, want: "warning"},
		{name: "missing live", mutate: func(_ *store.TaskSessionSource, live **liveSession) { *live = nil }, want: "warning"},
		{name: "wrong live session", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			(*live).Snapshot.SessionID = "77777777-7777-4777-8777-777777777777"
		}, want: "warning"},
		{name: "wrong live claim", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			(*live).Snapshot.ClaimID = "77777777-7777-4777-8777-777777777777"
		}, want: "warning"},
		{name: "wrong live generation", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.ExecutionGeneration = "1" }, want: "warning"},
		{name: "wrong live epoch", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.ConnectionEpoch = "2" }, want: "warning"},
		{name: "draining", mutate: func(source *store.TaskSessionSource, live **liveSession) {
			source.Session.Lifecycle = "draining"
			(*live).Snapshot.Activity = "unknown"
		}, want: "warning"},
		{name: "archived", mutate: func(source *store.TaskSessionSource, live **liveSession) {
			source.Session.Lifecycle = "archived"
			(*live).Snapshot.Synchronized = false
		}, want: "warning"},
		{name: "heartbeat exact", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			stamp := now.Add(-HeartbeatTimeout)
			source.Session.LastSeen = &stamp
		}, want: "working"},
		{name: "heartbeat expired", mutate: func(source *store.TaskSessionSource, live **liveSession) {
			stamp := now.Add(-HeartbeatTimeout - time.Nanosecond)
			source.Session.LastSeen = &stamp
			(*live).LastSeen = &now
		}, want: "warning"},
		{name: "live heartbeat stale", mutate: func(_ *store.TaskSessionSource, live **liveSession) {
			stamp := now.Add(-time.Hour)
			(*live).LastSeen = &stamp
		}, want: "working"},
		{name: "no durable heartbeat", mutate: func(source *store.TaskSessionSource, _ **liveSession) { source.Session.LastSeen = nil }, want: "warning"},
		{name: "drain exact", mutate: func(source *store.TaskSessionSource, _ **liveSession) { source.Session.DrainUntil = &now }, want: "warning"},
		{name: "drain not reached", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			deadline := now.Add(time.Nanosecond)
			source.Session.DrainUntil = &deadline
		}, want: "working"},
		{name: "completed task", mutate: func(source *store.TaskSessionSource, _ **liveSession) { source.TaskStatus = model.TaskDone }},
		{name: "missing worker", mutate: func(source *store.TaskSessionSource, _ **liveSession) { source.Worker = nil }},
		{name: "herdr worker", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Worker.AgentControlMode = model.AgentControlModeHerdr
		}},
		{name: "missing session", mutate: func(source *store.TaskSessionSource, _ **liveSession) { source.Session = nil }},
		{name: "row task mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.TaskID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "row claim mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.ClaimID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "row session mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.SessionID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot task mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Identity.TaskID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot project mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Identity.ProjectID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot claim mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Fence.ClaimID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot worker mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Identity.WorkerID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot worktree mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Identity.WorktreeID = "77777777-7777-4777-8777-777777777777"
		}},
		{name: "snapshot mode mismatch", mutate: func(source *store.TaskSessionSource, _ **liveSession) {
			source.Session.Identity.AgentControlMode = "herdr"
		}},
		{name: "live lifecycle not authoritative", mutate: func(_ *store.TaskSessionSource, live **liveSession) { (*live).Snapshot.Lifecycle = "archived" }, want: "working"},
	} {
		t.Run(test.name, func(t *testing.T) {
			source, live := taskListSource(now)
			if test.mutate != nil {
				test.mutate(&source, &live)
			}
			engine := NewEngine(nil)
			engine.now = func() time.Time { return now }
			if live != nil {
				engine.live["44444444-4444-4444-8444-444444444444"] = &liveCell{value: live}
			}
			before := cloneLive(live)
			got, err := engine.TaskListSessionStates(t.Context(), []store.TaskSessionSource{source})
			if err != nil || got == nil {
				t.Fatalf("states: %#v, %v", got, err)
			}
			if test.want == "" {
				if len(got) != 0 {
					t.Fatalf("unexpected contribution: %#v", got)
				}
			} else if len(got) != 1 || string(got[source.TaskID]) != test.want {
				t.Fatalf("states: %#v, want %s", got, test.want)
			}
			if !reflect.DeepEqual(live, before) {
				t.Fatal("list projection changed committed live state")
			}
			if engine.activeOperations != 0 {
				t.Fatal("read admission leaked")
			}
		})
	}
}

func TestTaskListSessionStatesEmptyAndAdmissionFailures(t *testing.T) {
	engine := NewEngine(nil)
	got, err := engine.TaskListSessionStates(t.Context(), []store.TaskSessionSource{})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty states: %#v, %v", got, err)
	}
	source, _ := taskListSource(time.Now().UTC())
	engine.live[source.Session.SessionID] = &liveCell{}
	got, err = engine.TaskListSessionStates(t.Context(), []store.TaskSessionSource{source})
	if err != nil || len(got) != 1 || got[source.TaskID] != model.SessionListWarning {
		t.Fatalf("empty committed cell: %#v, %v", got, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if got, err = engine.TaskListSessionStates(ctx, nil); !errors.Is(err, context.Canceled) || got != nil {
		t.Fatalf("cancelled states: %#v, %v", got, err)
	}
	engine.CancelWork()
	if got, err = engine.TaskListSessionStates(t.Context(), nil); err == nil || got != nil {
		t.Fatalf("cancel work states: %#v, %v", got, err)
	}
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, err = engine.TaskListSessionStates(t.Context(), nil); err == nil || got != nil {
		t.Fatalf("stopped states: %#v, %v", got, err)
	}
}
