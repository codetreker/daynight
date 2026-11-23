package bot

import (
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type botObservationFixture struct {
	bot    model.Bot
	source store.BotObservationSource
	live   store.BotSessionLive
	now    time.Time
}

func observationValue[T any](v T) *T { return &v }

func newBotObservationFixture() botObservationFixture {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	bot := model.Bot{ID: "bot", OwnerUserID: "owner", WorkerID: "original-worker", Version: 42,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: "original-worker", Provider: "codex"},
		SessionID:             observationValue("session"), TestExecutionID: observationValue("execution"),
		StartupResult: model.BotStartupResult{State: "ready"},
		Recovery:      &model.BotRecovery{WorkerID: "current-worker", MachineID: "machine", MachineName: "saved-name", HostingGeneration: 3}}
	v := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", TestExecutionID: "execution", ExecutionGeneration: "7"}, ConnectionEpoch: "11"},
		Identity: sp.Identity{OwnerUserID: "owner", WorkerID: "current-worker", Provider: "codex", NativeSessionID: observationValue("native-thread")}, Lifecycle: "active"}
	source := store.BotObservationSource{
		Worker: &model.WorkerSnapshot{UserID: "owner", WorkerID: "current-worker", LastReportedAt: now.Add(-10 * time.Second),
			Telemetry: model.WorkerTelemetry{Machine: model.WorkerMachine{ID: "machine", Name: "current-name"},
				AssistantHost: &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: now.Add(-10 * time.Second),
					Providers: []model.WorkerAssistantProvider{{Provider: "codex", Available: true}, {Provider: "copilot", Available: false}}}}},
		Session: &store.BotSessionSource{Snapshot: v, LastSeen: observationValue(now.Add(-5 * time.Second)), ConnectionExpiry: observationValue(now.Add(time.Minute)), ServerInstance: "server"},
	}
	live := store.BotSessionLive{ObservedAt: now, Available: true, Fence: v.ControllerFence, ConnectionState: "connected", Synchronized: true, SourceSynced: true, Activity: "idle"}
	return botObservationFixture{bot: bot, source: source, live: live, now: now}
}

func (f botObservationFixture) observe() Observation {
	return Observe(f.bot, f.source, f.live, f.now, 30*time.Second)
}

func TestBotObservationCurrentBindingAndActivity(t *testing.T) {
	f := newBotObservationFixture()
	got := f.observe()
	if got.BotID != f.bot.ID || got.BotVersion != 42 || got.WorkerID != "current-worker" || got.Provider != "codex" ||
		got.HostingGeneration == nil || *got.HostingGeneration != 3 || got.Machine == nil || *got.Machine != (model.WorkerMachine{ID: "machine", Name: "current-name"}) ||
		got.SessionID == nil || *got.SessionID != "session" || got.TestExecutionID == nil || *got.TestExecutionID != "execution" ||
		got.NativeSessionID == nil || *got.NativeSessionID != "native-thread" || got.ExecutionGeneration == nil || *got.ExecutionGeneration != "7" ||
		got.ConnectionEpoch == nil || *got.ConnectionEpoch != "11" || got.State != "idle" || got.Reason != "idle" || got.CurrentTurnID != nil {
		t.Fatalf("current Bot observation: %+v", got)
	}
	if f.bot.WorkerID != "original-worker" || f.bot.ResolvedConfiguration.WorkerID != "original-worker" || f.bot.Recovery.MachineName != "saved-name" {
		t.Fatal("reading changed the frozen definition or saved recovery binding")
	}
	for _, tc := range []struct{ activity, state, reason string }{
		{"working", "working", "working"}, {"waiting_input", "idle", "waiting_input"}, {"failed", "abnormal", "session_failed"},
		{"stopped", "abnormal", "session_stopped"}, {"unknown", "recovering", "activity_unknown"},
	} {
		t.Run(tc.activity, func(t *testing.T) {
			f := newBotObservationFixture()
			f.live.Activity, f.live.CurrentTurnID = tc.activity, observationValue("current-turn")
			got := f.observe()
			if got.State != tc.state || got.Reason != tc.reason || (got.CurrentTurnID != nil) != (tc.activity == "working") {
				t.Fatalf("activity %s: %+v", tc.activity, got)
			}
		})
	}
}

func TestBotObservationKeepsOtherWorkSeparate(t *testing.T) {
	f := newBotObservationFixture()
	want := f.observe()
	f.source.Worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, Items: []model.WorkerObservedTask{{TaskID: "other-task", Status: model.TaskInProgress, Phase: "executing"}}}
	f.source.Session.Snapshot.Activity = "working"
	f.source.Session.Snapshot.CurrentTurnID = observationValue("old-durable-turn")
	if got := f.observe(); !reflect.DeepEqual(got, want) {
		t.Fatalf("other work or durable activity changed this Bot's live state: %+v", got)
	}
}

func TestBotObservationOfflineRetainsLocationAndIdentity(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		f := newBotObservationFixture()
		if legacy {
			f.bot.Recovery = nil
			f.source.Worker.WorkerID = f.bot.WorkerID
		}
		f.source.Worker.LastReportedAt = f.now.Add(-90 * 24 * time.Hour)
		got := f.observe()
		if got.State != "offline" || got.Reason != "worker_heartbeat_expired" || got.Machine == nil || got.Machine.Name != "current-name" ||
			got.NativeSessionID == nil || *got.NativeSessionID != "native-thread" || got.WorkerLastSeenAt == nil || !got.WorkerLastSeenAt.Equal(f.source.Worker.LastReportedAt) || got.FreshUntil != nil || got.CurrentTurnID != nil {
			t.Fatalf("offline legacy=%v: %+v", legacy, got)
		}
	}
	f := newBotObservationFixture()
	f.source.Worker = nil
	got := f.observe()
	if got.State != "offline" || got.Reason != "worker_unobserved" || got.Machine == nil || got.Machine.Name != "saved-name" || got.WorkerLastSeenAt != nil {
		t.Fatalf("unobserved Worker lost recovery machine: %+v", got)
	}
	f.bot.Recovery, f.source.Session = nil, nil
	got = f.observe()
	if got.Machine != nil || got.NativeSessionID != nil || got.SessionLastSeenAt != nil || got.HostingGeneration != nil {
		t.Fatalf("unknown identities were invented: %+v", got)
	}
}

func TestBotObservationRejectsUnavailableAndOldReadyEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, state, reason string
		change              func(*botObservationFixture)
	}{
		{"failed_startup", "abnormal", "native_record_missing", func(f *botObservationFixture) {
			f.bot.StartupResult = model.BotStartupResult{State: "failed", Code: observationValue("native_record_missing")}
		}},
		{"failed_without_code", "abnormal", "startup_failed", func(f *botObservationFixture) { f.bot.StartupResult.State = "failed" }},
		{"execution_conflict", "abnormal", "execution_conflict", func(f *botObservationFixture) {
			f.bot.StartupResult = model.BotStartupResult{State: "failed", Code: observationValue("execution_conflict")}
		}},
		{"old_ready_after_takeover", "recovering", "startup_pending", func(f *botObservationFixture) { f.bot.StartupResult.State = "pending" }},
		{"old_generation", "recovering", "session_observation_unavailable", func(f *botObservationFixture) { f.live.Fence.ExecutionGeneration = "6" }},
		{"old_connection", "recovering", "session_observation_unavailable", func(f *botObservationFixture) { f.live.Fence.ConnectionEpoch = "10" }},
		{"missing_live", "recovering", "session_observation_unavailable", func(f *botObservationFixture) { f.live.Available = false }},
		{"reset_connection", "recovering", "connection_reset", func(f *botObservationFixture) { f.live.ConnectionState = "disconnected" }},
		{"unsynchronized", "recovering", "session_synchronizing", func(f *botObservationFixture) { f.live.Synchronized = false }},
		{"source_unsynchronized", "recovering", "session_synchronizing", func(f *botObservationFixture) { f.live.SourceSynced = false }},
		{"no_lease", "recovering", "connection_expired", func(f *botObservationFixture) { f.source.Session.ConnectionExpiry = nil }},
		{"no_heartbeat", "recovering", "session_heartbeat_expired", func(f *botObservationFixture) { f.source.Session.LastSeen = nil }},
		{"future_heartbeat", "recovering", "session_heartbeat_expired", func(f *botObservationFixture) {
			f.source.Session.LastSeen = observationValue(f.now.Add(time.Nanosecond))
		}},
		{"no_native_id", "connecting", "native_session_pending", func(f *botObservationFixture) { f.source.Session.Snapshot.Identity.NativeSessionID = nil }},
		{"no_session", "connecting", "session_unregistered", func(f *botObservationFixture) {
			f.bot.SessionID, f.bot.TestExecutionID, f.source.Session = nil, nil, nil
		}},
		{"missing_session_record", "abnormal", "session_missing", func(f *botObservationFixture) { f.source.Session = nil }},
		{"inactive_session", "abnormal", "session_inactive", func(f *botObservationFixture) { f.source.Session.Snapshot.Lifecycle = "archived" }},
		{"wrong_host_worker", "abnormal", "hosting_identity_mismatch", func(f *botObservationFixture) { f.source.Worker.WorkerID = "old-worker" }},
		{"wrong_host_machine", "abnormal", "hosting_identity_mismatch", func(f *botObservationFixture) { f.source.Worker.Telemetry.Machine.ID = "other-machine" }},
		{"wrong_session", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.source.Session.Snapshot.SessionID = "other-session" }},
		{"wrong_owner", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.source.Session.Snapshot.Identity.OwnerUserID = "other-owner" }},
		{"wrong_provider", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.source.Session.Snapshot.Identity.Provider = "claude" }},
		{"wrong_execution", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.source.Session.Snapshot.TestExecutionID = "other-execution" }},
		{"unknown_execution", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.source.Session.Snapshot.TestExecutionID = "" }},
		{"no_execution_binding", "abnormal", "session_identity_mismatch", func(f *botObservationFixture) { f.bot.TestExecutionID = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotObservationFixture()
			f.live.Activity, f.live.CurrentTurnID = "working", observationValue("old-turn")
			tc.change(&f)
			got := f.observe()
			if got.State != tc.state || got.Reason != tc.reason || got.CurrentTurnID != nil {
				t.Fatalf("got %+v, want %s/%s without current turn", got, tc.state, tc.reason)
			}
		})
	}
}

func TestBotObservationHeartbeatAndLeaseBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, state, reason string
		adjust              func(*botObservationFixture)
	}{
		{"worker_just_fresh", "idle", "idle", func(f *botObservationFixture) {
			f.source.Worker.LastReportedAt = f.now.Add(-120*time.Second + time.Nanosecond)
		}},
		{"worker_exact_expiry", "offline", "worker_heartbeat_expired", func(f *botObservationFixture) { f.source.Worker.LastReportedAt = f.now.Add(-120 * time.Second) }},
		{"worker_just_expired", "offline", "worker_heartbeat_expired", func(f *botObservationFixture) {
			f.source.Worker.LastReportedAt = f.now.Add(-120*time.Second - time.Nanosecond)
		}},
		{"worker_future", "offline", "worker_heartbeat_expired", func(f *botObservationFixture) { f.source.Worker.LastReportedAt = f.now.Add(time.Nanosecond) }},
		{"session_just_fresh", "idle", "idle", func(f *botObservationFixture) {
			f.source.Session.LastSeen = observationValue(f.now.Add(-30*time.Second + time.Nanosecond))
		}},
		{"session_exact_expiry", "recovering", "session_heartbeat_expired", func(f *botObservationFixture) {
			f.source.Session.LastSeen = observationValue(f.now.Add(-30 * time.Second))
		}},
		{"lease_just_fresh", "idle", "idle", func(f *botObservationFixture) {
			f.source.Session.ConnectionExpiry = observationValue(f.now.Add(time.Nanosecond))
		}},
		{"lease_exact_expiry", "recovering", "connection_expired", func(f *botObservationFixture) { f.source.Session.ConnectionExpiry = observationValue(f.now) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotObservationFixture()
			tc.adjust(&f)
			got := f.observe()
			if got.State != tc.state || got.Reason != tc.reason {
				t.Fatalf("got %+v, want %s/%s", got, tc.state, tc.reason)
			}
		})
	}
	for _, tc := range []struct {
		name     string
		deadline time.Duration
		adjust   func(*botObservationFixture)
	}{
		{"session", 25 * time.Second, func(f *botObservationFixture) {}},
		{"worker", 10 * time.Second, func(f *botObservationFixture) { f.source.Worker.LastReportedAt = f.now.Add(-110 * time.Second) }},
		{"lease", 4 * time.Second, func(f *botObservationFixture) {
			f.source.Session.ConnectionExpiry = observationValue(f.now.Add(4 * time.Second))
		}},
		{"provider", time.Second, func(f *botObservationFixture) {
			f.source.Worker.Telemetry.AssistantHost.ObservedAt = f.now.Add(-119 * time.Second)
			f.source.Worker.Telemetry.AssistantHost.Providers[0].Available = false
		}},
	} {
		t.Run("fresh_until_"+tc.name, func(t *testing.T) {
			f := newBotObservationFixture()
			tc.adjust(&f)
			got := f.observe()
			if got.FreshUntil == nil || !got.FreshUntil.Equal(f.now.Add(tc.deadline)) || !got.ObservedAt.Equal(f.now) || got.ObservedAt.Location() != time.UTC {
				t.Fatalf("freshness deadline got %+v, want now+%s", got, tc.deadline)
			}
		})
	}
}

func TestBotObservationProviderEvidenceFreshness(t *testing.T) {
	for _, tc := range []struct {
		name  string
		age   time.Duration
		state string
	}{
		{"fresh_failure", 119 * time.Second, "abnormal"},
		{"expired_failure", 120 * time.Second, "idle"},
		{"future_failure", -time.Nanosecond, "idle"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotObservationFixture()
			f.source.Worker.Telemetry.AssistantHost.ObservedAt = f.now.Add(-tc.age)
			f.source.Worker.Telemetry.AssistantHost.Providers[0].Available = false
			got := f.observe()
			if got.State != tc.state || (tc.state == "abnormal" && got.Reason != "provider_unavailable") {
				t.Fatalf("provider evidence: %+v", got)
			}
		})
	}
	f := newBotObservationFixture()
	f.source.Worker.Telemetry.AssistantHost = nil
	if got := f.observe(); got.State != "idle" {
		t.Fatalf("missing preflight displaced synchronized Session: %+v", got)
	}
}

func TestBotObservationLiveSampleFreshness(t *testing.T) {
	for _, tc := range []struct {
		name      string
		age       time.Duration
		zero      bool
		state     string
		remaining time.Duration
	}{
		{name: "missing_time", zero: true, state: "recovering"},
		{name: "future_time", age: -time.Nanosecond, state: "recovering"},
		{name: "exact_expiry", age: 30 * time.Second, state: "recovering"},
		{name: "just_expired", age: 30*time.Second + time.Nanosecond, state: "recovering"},
		{name: "just_fresh", age: 30*time.Second - time.Nanosecond, state: "working", remaining: time.Nanosecond},
		{name: "sample_limits_deadline", age: 25 * time.Second, state: "working", remaining: 5 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotObservationFixture()
			f.source.Worker.LastReportedAt = f.now
			f.source.Session.LastSeen = observationValue(f.now)
			f.live.Activity, f.live.CurrentTurnID = "working", observationValue("sampled-turn")
			f.live.ObservedAt = f.now.Add(-tc.age)
			if tc.zero {
				f.live.ObservedAt = time.Time{}
			}
			got := f.observe()
			if got.State != tc.state {
				t.Fatalf("sample freshness: %+v, want %s", got, tc.state)
			}
			if tc.state == "recovering" {
				if got.Reason != "session_observation_unavailable" || got.CurrentTurnID != nil {
					t.Fatalf("invalid sample exposed current work: %+v", got)
				}
			} else if got.Reason != "working" || got.CurrentTurnID == nil || *got.CurrentTurnID != "sampled-turn" || got.FreshUntil == nil || !got.FreshUntil.Equal(f.now.Add(tc.remaining)) {
				t.Fatalf("sample deadline: %+v, want now+%s", got, tc.remaining)
			}
		})
	}
}
