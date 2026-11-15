package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// TaskSyncSessions samples the live registry once and applies the independent
// current-observation and legacy aggregate rules to the same committed facts.
func (s *Engine) TaskSyncSessions(ctx context.Context, principal model.Principal, sources []store.TaskSessionSource) (map[string]model.TaskSyncObservation, map[string]model.SessionListState, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return nil, nil, err
	}
	op, err := s.BeginOperation()
	if err != nil {
		return nil, nil, err
	}
	defer op.Close()
	live, err := s.readTaskSessionLiveStates(ctx, op, sources)
	if err != nil {
		return nil, nil, err
	}
	now := s.now().UTC()
	if !validSyncTime(now) {
		return nil, nil, fault("session_clock_invalid", "Session observation clock is unavailable.")
	}
	observations := make(map[string]model.TaskSyncObservation, len(sources))
	legacy := make(map[string]model.SessionListState)
	for _, source := range sources {
		var state *taskSessionLiveState
		if source.Session != nil {
			state = live[source.Session.SessionID]
		}
		if value, ok := taskListSessionState(source, state, now); ok {
			legacy[source.TaskID] = value
		}
		observations[source.TaskID] = s.taskSyncObservation(principal, source, state, now)
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return nil, nil, err
	}
	return observations, legacy, nil
}

// TaskSyncObservedAt reads the same clock used for observation timestamps after
// the caller has finished all sampling and authorization rechecks.
func (s *Engine) TaskSyncObservedAt(ctx context.Context) (time.Time, error) {
	op, err := s.BeginOperation()
	if err != nil {
		return time.Time{}, err
	}
	defer op.Close()
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return time.Time{}, err
	}
	now := s.now().UTC()
	if !validSyncTime(now) {
		return time.Time{}, fault("session_clock_invalid", "Session observation clock is unavailable.")
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return time.Time{}, err
	}
	return now, nil
}

func validSyncTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1 && value.Year() <= 9999
}

func (s *Engine) taskSyncObservation(principal model.Principal, source store.TaskSessionSource, live *taskSessionLiveState, now time.Time) model.TaskSyncObservation {
	return taskSessionRowObservation(source, live, s.observeTaskSession(principal, source, live, now, false), now)
}

func taskSessionRowObservation(source store.TaskSessionSource, live *taskSessionLiveState, observation sp.TaskSessionObservation, now time.Time) model.TaskSyncObservation {
	result := model.TaskSyncObservation{TaskVersion: source.TaskVersion, State: "unavailable"}
	// Retained completed claims and their Sessions are machine history, not the
	// current execution of a manually restarted Task.
	if source.Worker == nil || source.Worker.State == model.WorkerCompleted {
		until := now.Add(HeartbeatTimeout)
		result.State, result.ObservedAt = "no_session", &now
		if validSyncTime(until) {
			result.FreshUntil = &until
		}
		return result
	}
	if source.Worker.State != model.WorkerActive {
		return result
	}
	// Task-scoped web snapshots do not carry OwnerUserID; the stored Session
	// owner, not the snapshot identity, binds the registration to the Worker.
	if source.Session != nil && (source.Worker.UserID == "" || !source.Worker.Agent.Valid() || source.Session.OwnerID != source.Worker.UserID || source.Session.Identity.Provider != string(source.Worker.Agent)) {
		return result
	}
	if source.Session != nil && source.Session.Backend == "herdr" && source.Session.Identity.OwnerUserID != source.Session.OwnerID {
		return result
	}
	if observation.ObservedAt != nil && validSyncTime(*observation.ObservedAt) {
		result.ObservedAt = observation.ObservedAt
	}
	if observation.FreshUntil != nil && validSyncTime(*observation.FreshUntil) {
		result.FreshUntil = observation.FreshUntil
	}
	result.NeedsAttention = observation.NeedsAttention
	if observation.Observation != "observed" || observation.Error != nil || result.ObservedAt == nil {
		return result
	}
	switch observation.Registration {
	case "not_applicable":
		if observation.Reason == "no_execution" {
			result.State = "no_session"
		}
		return result
	case "not_registered":
		result.State = "not_registered"
		return result
	case "registered":
	default:
		return result
	}
	result.CanOpen = result.FreshUntil != nil && syncReadableSource(source, live, observation, now)
	if observation.Lifecycle == nil || observation.ConnectionState == nil {
		return result
	}
	if *observation.Lifecycle != "active" || *observation.ConnectionState == "disconnected" {
		result.State = "warning"
		return result
	}
	if observation.Indicator != nil {
		switch *observation.Indicator {
		case "working", "notice", "warning", "pending":
			result.State = *observation.Indicator
			return result
		}
	}
	if source.Session.Backend == "web" && observation.Activity != nil && *observation.Activity != "unknown" && observation.Reason == "synchronizing" {
		result.State = "pending"
		return result
	}
	// The legacy indicator computes explicit pending states for activities such
	// as initialization even when the observation has no indicator field.
	if source.Session.Backend == "web" && observation.Activity != nil && *observation.Activity != "unknown" {
		if value, ok := taskListSessionState(source, live, now); ok && value == model.SessionListPending {
			result.State = "pending"
		}
	}
	return result
}

func syncReadableSource(source store.TaskSessionSource, live *taskSessionLiveState, observation sp.TaskSessionObservation, now time.Time) bool {
	if source.Session == nil || !validObservationIdentity(source) || !currentObservationBinding(source) || source.Worker == nil || source.Worker.State != model.WorkerActive {
		return false
	}
	// CurrentTerminal reads the registered terminal record for this claim even
	// when its connection is down; it does not use native chat history admission.
	if source.Session.Backend == "herdr" {
		return true
	}
	if source.Session.ArchiveState == "ready" {
		return true
	}
	return inspectionLiveSource(source.Session, live, observation, now)
}
