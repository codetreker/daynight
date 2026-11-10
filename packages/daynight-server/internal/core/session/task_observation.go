package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func observationPointer[T any](value T) *T { return &value }
func copyObservationPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return observationPointer(*value)
}

// ObserveTaskSessions consumes authorized Task snapshot sources. It samples only
// committed live scalars; authorization and selected Task versions remain owned
// by the caller's snapshot coordinator.
func (s *Engine) ObserveTaskSessions(ctx context.Context, p model.Principal, sources []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	op, err := s.BeginOperation()
	if err != nil {
		return nil, err
	}
	defer op.Close()
	live, err := s.readTaskSessionLiveStates(ctx, op, sources)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	out := make(map[string]sp.TaskSessionObservation, len(sources))
	for _, source := range sources {
		var state *taskSessionLiveState
		if source.Session != nil {
			state = live[source.Session.SessionID]
		}
		out[source.TaskID] = s.observeTaskSession(p, source, state, now, false)
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Engine) InspectTaskSession(ctx context.Context, p model.Principal, source store.TaskSessionSource) (sp.TaskSessionInspection, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return sp.TaskSessionInspection{}, err
	}
	if source.Session == nil {
		return sp.TaskSessionInspection{}, fault("not_found", "Session was not found.")
	}
	if !validObservationIdentity(source) {
		return sp.TaskSessionInspection{}, fault("source_corrupt", "The stored Session identity is inconsistent.")
	}
	if err := ctx.Err(); err != nil {
		return sp.TaskSessionInspection{}, err
	}
	op, err := s.BeginOperation()
	if err != nil {
		return sp.TaskSessionInspection{}, err
	}
	defer op.Close()
	live, err := s.readTaskSessionLiveStates(ctx, op, []store.TaskSessionSource{source})
	if err != nil {
		return sp.TaskSessionInspection{}, err
	}
	now := s.now().UTC()
	state := live[source.Session.SessionID]
	observation := s.observeTaskSession(p, source, state, now, true)
	if observation.Observation == "unavailable" {
		setTaskObservationIdentity(&observation, source.Session)
	}
	current := currentObservationBinding(source)
	kind := "unavailable"
	if source.Session.ArchiveState == "ready" {
		kind = "archive"
	}
	if current && observation.Observation == "observed" && inspectionLiveSource(source.Session, state, observation, now) {
		kind = "live"
	}
	out := sp.TaskSessionInspection{SchemaVersion: 1, ProjectID: source.ProjectID, TaskID: source.TaskID, SessionID: source.Session.SessionID, CurrentBinding: current, Fence: source.Session.Fence, Source: kind, Session: observation}
	if kind == "live" && state != nil {
		out.ContentReadVersion = state.ContentReadVersion
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return sp.TaskSessionInspection{}, err
	}
	return out, nil
}

func inspectionLiveSource(d *store.TaskSessionStateSource, live *taskSessionLiveState, observation sp.TaskSessionObservation, now time.Time) bool {
	if d.Backend != "web" || live == nil || live.Fence != d.Fence {
		return false
	}
	// Content admission owns the source's synchronization, heartbeat and expiry
	// rules. Draining may retain readable content while disallowing messages.
	r := &record{
		Snapshot: sp.Snapshot{Lifecycle: *observation.Lifecycle, ConnectionState: live.ConnectionState, Synchronized: live.Synchronized},
		Live:     &liveSession{Synced: live.SourceSynced}, LastSeen: d.LastSeen, ConnectionExpiry: d.ConnectionExpiry,
	}
	return onlineContent(r, now) == nil
}

func setTaskObservationIdentity(out *sp.TaskSessionObservation, d *store.TaskSessionStateSource) {
	out.Registration = "registered"
	out.SessionID = observationPointer(d.SessionID)
	out.NativeSessionID = copyObservationPointer(d.Identity.NativeSessionID)
	out.ClaimID = observationPointer(d.ClaimID)
	out.ExecutionGeneration = observationPointer(d.Fence.ExecutionGeneration)
	out.ConnectionEpoch = observationPointer(d.Fence.ConnectionEpoch)
	out.AgentControlMode = observationPointer(d.Backend)
	out.Provider = observationPointer(d.Identity.Provider)
}

func validObservationIdentity(source store.TaskSessionSource) bool {
	d := source.Session
	if d == nil {
		return false
	}
	i := d.Identity
	return d.SessionID == d.Fence.SessionID && d.ClaimID == d.Fence.ClaimID && d.TaskID == source.TaskID && i.TaskID == source.TaskID && d.ProjectID == source.ProjectID && i.ProjectID == source.ProjectID && d.Backend == i.AgentControlMode
}
func currentObservationBinding(source store.TaskSessionSource) bool {
	d, w := source.Session, source.Worker
	if d == nil || w == nil {
		return false
	}
	return d.ClaimID == w.ClaimID && d.Identity.WorkerID == w.WorkerID && d.Identity.WorktreeID == w.WorktreeID && d.Backend == string(w.AgentControlMode)
}
func unavailableTaskObservation(now time.Time, reason string) sp.TaskSessionObservation {
	return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "unavailable", Registration: "unknown", Reason: reason, ObservedAt: &now, Send: sp.TaskSessionSend{Reason: reason}, Error: &sp.OperationError{Code: reason, Message: "The selected execution changed before Session observation completed."}}
}
func (s *Engine) observeTaskSession(p model.Principal, source store.TaskSessionSource, live *taskSessionLiveState, now time.Time, allowHistorical bool) sp.TaskSessionObservation {
	out := sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_applicable", Reason: "no_execution", ObservedAt: &now, FreshUntil: observationPointer(now.Add(HeartbeatTimeout)), Send: sp.TaskSessionSend{Allowed: observationPointer(false), Reason: "no_execution"}}
	w, d := source.Worker, source.Session
	if source.TaskStatus == model.TaskTodo {
		out.Reason = "not_started"
		out.Send.Reason = out.Reason
	}
	if w != nil {
		out.ClaimID = observationPointer(w.ClaimID)
		out.AgentControlMode = observationPointer(string(w.AgentControlMode))
		out.Provider = observationPointer(string(w.Agent))
		out.Registration = "not_registered"
		out.Reason = "not_registered"
		out.Send.Reason = out.Reason
	}
	if d == nil {
		return out
	}
	if !validObservationIdentity(source) || !allowHistorical && !currentObservationBinding(source) {
		return unavailableTaskObservation(now, "execution_changed")
	}
	current := currentObservationBinding(source)
	if d.Backend == "web" && live != nil && live.Fence != d.Fence {
		return unavailableTaskObservation(now, "execution_changed")
	}
	setTaskObservationIdentity(&out, d)
	if d.LastSeen == nil {
		out.FreshUntil = nil
	} else {
		out.LastSeenAt = observationPointer(d.LastSeen.UTC())
		until := out.LastSeenAt.Add(HeartbeatTimeout)
		if until.Before(*out.FreshUntil) {
			out.FreshUntil = &until
		}
	}
	if d.ConnectionExpiry != nil && out.FreshUntil != nil && d.ConnectionExpiry.Before(*out.FreshUntil) {
		out.FreshUntil = observationPointer(d.ConnectionExpiry.UTC())
	}
	if d.Backend == "herdr" {
		out.ContentKind = observationPointer("terminal_recording")
		lifecycle := "active"
		if d.TerminalFinalizationID != nil {
			lifecycle = "archived"
		}
		out.Lifecycle = &lifecycle
		connection := "disconnected"
		if current && source.TaskStatus == model.TaskInProgress && w.State == model.WorkerActive && d.TerminalFinalizationID == nil && d.ServerInstance == s.instance && d.LastSeen != nil && now.Sub(*d.LastSeen) <= HeartbeatTimeout {
			connection = "connected"
		}
		out.ConnectionState = &connection
		out.Reason = connection
		out.Send.Reason = "unsupported_mode"
		return out
	}
	out.ContentKind = observationPointer("native_timeline")
	v := sp.Snapshot{ControllerFence: d.Fence, Identity: d.Identity, InitialInputState: d.InitialInputState, Lifecycle: d.Lifecycle, ConnectionState: "disconnected", Activity: "unknown"}
	if live != nil {
		v.ConnectionState, v.Synchronized, v.Activity, v.Capabilities, v.CurrentTurnID = live.ConnectionState, live.Synchronized, live.Activity, live.Capabilities, copyObservationPointer(live.CurrentTurnID)
	}
	if d.DrainUntil != nil && !now.Before(*d.DrainUntil) {
		v.Lifecycle = "archived"
	}
	if d.LastSeen == nil || now.Sub(*d.LastSeen) > HeartbeatTimeout {
		v.ConnectionState = "disconnected"
	}
	out.Activity = &v.Activity
	out.ConnectionState = &v.ConnectionState
	out.Lifecycle = &v.Lifecycle
	out.CurrentTurnID = v.CurrentTurnID
	out.Reason = v.Activity
	if v.Lifecycle != "active" {
		out.Reason = v.Lifecycle
	} else if v.ConnectionState == "disconnected" {
		out.Reason = "disconnected"
	} else if !v.Synchronized || v.ConnectionState != "connected" {
		out.Reason = "synchronizing"
	}
	if current && source.TaskStatus == model.TaskInProgress {
		if state, ok := taskSessionIndicator(v.Lifecycle, v.ConnectionState, v.Synchronized, v.Activity); ok && state != model.SessionListPending {
			out.Indicator = observationPointer(string(state))
			out.NeedsAttention = observationPointer(state != model.SessionListWorking)
		}
	}
	switch {
	case p.UserID != d.OwnerID:
		out.Send.Reason = "not_owner"
	case !current:
		out.Send.Reason = "not_current"
	case source.TaskStatus != model.TaskInProgress || w.State != model.WorkerActive:
		out.Send.Reason = "execution_inactive"
	case d.ConnectionExpiry == nil || !now.Before(*d.ConnectionExpiry):
		out.Send.Reason = "connection_expired"
	default:
		mode, reason := messageSendEligibility(v, false)
		out.Send.Reason = reason
		if reason == "allowed" {
			out.Send.Allowed = observationPointer(true)
			out.Send.Mode = &mode
		}
	}
	return out
}

// messageSendEligibility is shared by permission snapshots and read summaries.
// Ownership and the current Task binding are established by their callers.
func messageSendEligibility(v sp.Snapshot, firstInputBlocked bool) (string, string) {
	if v.Lifecycle != "active" {
		return "", v.Lifecycle
	}
	if v.ConnectionState != "connected" {
		if v.ConnectionState == "disconnected" {
			return "", "disconnected"
		}
		return "", "synchronizing"
	}
	if !v.Synchronized {
		return "", "synchronizing"
	}
	if !v.Capabilities.Send {
		return "", "send_unsupported"
	}
	accepted := v.InitialInputState == "provider_accepted" || v.InitialInputState == "confirmed" || v.TestExecutionID != "" && v.InitialInputState == "not_required"
	if !accepted {
		return "", "initial_input_pending"
	}
	first := v.TestExecutionID != "" && v.InitialInputState == "not_required" && v.Activity == "idle"
	if v.Identity.NativeSessionID == nil && !first {
		return "", "native_session_unavailable"
	}
	if v.TestExecutionID != "" && v.Identity.NativeSessionID == nil && firstInputBlocked {
		return "", "first_input_pending"
	}
	switch v.Activity {
	case "idle":
		return "start", "allowed"
	case "working":
		if !v.Capabilities.Steer {
			return "", "steer_unavailable"
		}
		if v.CurrentTurnID == nil {
			return "", "turn_unavailable"
		}
		return "steer", "allowed"
	default:
		return "", v.Activity
	}
}
