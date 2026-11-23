package bot

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

// Observation describes current availability without granting input authority.
// Nullable identities and timestamps remain unknown until actually observed.
type Observation struct {
	BotID               string
	BotVersion          int64
	WorkerID            string
	Machine             *model.WorkerMachine
	Provider            string
	SessionID           *string
	TestExecutionID     *string
	NativeSessionID     *string
	HostingGeneration   *int64
	ExecutionGeneration *string
	ConnectionEpoch     *string
	State               string
	Reason              string
	ObservedAt          time.Time
	WorkerLastSeenAt    *time.Time
	SessionLastSeenAt   *time.Time
	FreshUntil          *time.Time
	CurrentTurnID       *string
}

func observationPointer[T any](value T) *T { return &value }

// Observe combines durable binding, Worker liveness and a committed Session
// sample. The caller must authorize the Bot and recheck its binding after sampling.
func Observe(bot model.Bot, source store.BotObservationSource, live store.BotSessionLive, now time.Time, heartbeatTimeout time.Duration) Observation {
	out := Observation{BotID: bot.ID, BotVersion: bot.Version, WorkerID: bot.WorkerID,
		Provider: bot.ResolvedConfiguration.Provider, SessionID: bot.SessionID,
		TestExecutionID: bot.TestExecutionID, State: "connecting", Reason: "session_unregistered", ObservedAt: now.UTC()}
	if bot.Recovery != nil {
		out.WorkerID = bot.Recovery.WorkerID
		out.HostingGeneration = observationPointer(bot.Recovery.HostingGeneration)
		out.Machine = &model.WorkerMachine{ID: bot.Recovery.MachineID, Name: bot.Recovery.MachineName}
	}
	w := source.Worker
	if w != nil {
		out.WorkerLastSeenAt = observationPointer(w.LastReportedAt.UTC())
		machine := w.Telemetry.Machine
		if machine.ID != "" && (out.Machine == nil || machine.ID == out.Machine.ID) {
			out.Machine = &machine
		}
	}
	if s := source.Session; s != nil {
		out.NativeSessionID = s.Snapshot.Identity.NativeSessionID
		out.ExecutionGeneration = observationPointer(s.Snapshot.ExecutionGeneration)
		out.ConnectionEpoch = observationPointer(s.Snapshot.ConnectionEpoch)
		out.SessionLastSeenAt = s.LastSeen
	}
	set := func(state, reason string) Observation { out.State, out.Reason = state, reason; return out }
	if w == nil {
		return set("offline", "worker_unobserved")
	}
	if !workercore.ActiveAt(w.LastReportedAt, now) {
		return set("offline", "worker_heartbeat_expired")
	}
	out.FreshUntil = observationPointer(w.LastReportedAt.Add(workercore.ActiveWindow).UTC())
	if w.WorkerID != out.WorkerID || (bot.Recovery != nil && w.Telemetry.Machine.ID != bot.Recovery.MachineID) {
		return set("abnormal", "hosting_identity_mismatch")
	}
	if bot.StartupResult.State == "failed" {
		reason := "startup_failed"
		if bot.StartupResult.Code != nil {
			reason = *bot.StartupResult.Code
		}
		return set("abnormal", reason)
	}
	if host := w.Telemetry.AssistantHost; host != nil && workercore.ActiveAt(host.ObservedAt, now) {
		for _, provider := range host.Providers {
			if string(provider.Provider) == out.Provider && !provider.Available {
				deadline := host.ObservedAt.Add(workercore.ActiveWindow)
				if deadline.Before(*out.FreshUntil) {
					out.FreshUntil = observationPointer(deadline.UTC())
				}
				return set("abnormal", "provider_unavailable")
			}
		}
	}
	if bot.SessionID == nil {
		return out
	}
	if source.Session == nil {
		return set("abnormal", "session_missing")
	}
	s := source.Session
	v := s.Snapshot
	if v.SessionID != *bot.SessionID || v.Identity.OwnerUserID != bot.OwnerUserID || v.Identity.Provider != out.Provider || v.TestExecutionID == "" || bot.TestExecutionID == nil || v.TestExecutionID != *bot.TestExecutionID {
		return set("abnormal", "session_identity_mismatch")
	}
	if v.Identity.NativeSessionID == nil {
		return set("connecting", "native_session_pending")
	}
	if v.Lifecycle != "active" {
		return set("abnormal", "session_inactive")
	}
	if bot.StartupResult.State != "ready" {
		return set("recovering", "startup_pending")
	}
	if s.ConnectionExpiry == nil || !now.Before(*s.ConnectionExpiry) {
		return set("recovering", "connection_expired")
	}
	if s.LastSeen == nil || s.LastSeen.After(now) || !now.Before(s.LastSeen.Add(heartbeatTimeout)) {
		return set("recovering", "session_heartbeat_expired")
	}
	for _, deadline := range []time.Time{*s.ConnectionExpiry, s.LastSeen.Add(heartbeatTimeout)} {
		if deadline.Before(*out.FreshUntil) {
			out.FreshUntil = observationPointer(deadline.UTC())
		}
	}
	if !live.Available || live.Fence != v.ControllerFence || live.ObservedAt.IsZero() || live.ObservedAt.After(now) || !now.Before(live.ObservedAt.Add(heartbeatTimeout)) {
		return set("recovering", "session_observation_unavailable")
	}
	if deadline := live.ObservedAt.Add(heartbeatTimeout); deadline.Before(*out.FreshUntil) {
		out.FreshUntil = observationPointer(deadline.UTC())
	}
	if live.ConnectionState != "connected" {
		return set("recovering", "connection_reset")
	}
	if !live.Synchronized || !live.SourceSynced {
		return set("recovering", "session_synchronizing")
	}
	switch live.Activity {
	case "working":
		out.CurrentTurnID = live.CurrentTurnID
		return set("working", "working")
	case "idle", "waiting_input":
		return set("idle", live.Activity)
	case "failed", "stopped":
		return set("abnormal", "session_"+live.Activity)
	default:
		return set("recovering", "activity_unknown")
	}
}
