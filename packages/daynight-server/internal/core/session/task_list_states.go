package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type taskSessionLiveState struct {
	Fence           sp.ControllerFence
	ConnectionState string
	Synchronized    bool
	Activity        string
}

func (s *Engine) TaskListSessionStates(ctx context.Context, sources []store.TaskSessionSource) (map[string]model.SessionListState, error) {
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
	now := s.now()
	result := make(map[string]model.SessionListState)
	for _, source := range sources {
		var state *taskSessionLiveState
		if source.Session != nil {
			state = live[source.Session.SessionID]
		}
		if value, contributes := taskListSessionState(source, state, now); contributes {
			result[source.TaskID] = value
		}
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return nil, err
	}
	return result, nil
}

func taskSessionReadAdmission(ctx context.Context, op *Operation) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-op.Stopping():
		return fault("service_unavailable", "Session work is stopping.")
	default:
		return nil
	}
}

func (s *Engine) readTaskSessionLiveStates(ctx context.Context, op *Operation, sources []store.TaskSessionSource) (map[string]*taskSessionLiveState, error) {
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return nil, err
	}
	cells := make(map[string]*liveCell)
	s.liveMutex.Lock()
	for _, source := range sources {
		if source.Session != nil {
			id := source.Session.SessionID
			if cell := s.live[id]; cell != nil {
				cells[id] = cell
			}
		}
	}
	s.liveMutex.Unlock()
	result := make(map[string]*taskSessionLiveState, len(cells))
	for id, cell := range cells {
		if err := taskSessionReadAdmission(ctx, op); err != nil {
			return nil, err
		}
		cell.mu.Lock()
		var state *taskSessionLiveState
		if value := cell.value; value != nil {
			state = &taskSessionLiveState{Fence: value.Snapshot.ControllerFence, ConnectionState: value.Snapshot.ConnectionState, Synchronized: value.Snapshot.Synchronized, Activity: value.Snapshot.Activity}
		}
		cell.mu.Unlock()
		if err := taskSessionReadAdmission(ctx, op); err != nil {
			return nil, err
		}
		// Registry removal may occur while a committed cell is being read. Recheck
		// only after unlocking it: content admission takes registry before cell.
		s.liveMutex.Lock()
		registered := s.live[id] == cell
		s.liveMutex.Unlock()
		if registered && state != nil {
			result[id] = state
		}
	}
	return result, nil
}

func taskListSessionState(source store.TaskSessionSource, live *taskSessionLiveState, now time.Time) (model.SessionListState, bool) {
	w, durable := source.Worker, source.Session
	if source.TaskStatus != model.TaskInProgress || w == nil || w.AgentControlMode != model.AgentControlModeWeb || durable == nil {
		return "", false
	}
	i := durable.Identity
	if durable.SessionID != durable.Fence.SessionID || durable.ClaimID != durable.Fence.ClaimID || durable.ClaimID != w.ClaimID ||
		durable.TaskID != source.TaskID || i.TaskID != source.TaskID || durable.ProjectID != i.ProjectID ||
		i.WorkerID != w.WorkerID || i.WorktreeID != w.WorktreeID || i.AgentControlMode != string(w.AgentControlMode) {
		return "", false
	}
	lifecycle, connection, synchronized, activity := durable.Lifecycle, "disconnected", false, "unknown"
	if live != nil && live.Fence == durable.Fence {
		connection, synchronized, activity = live.ConnectionState, live.Synchronized, live.Activity
	}
	if durable.DrainUntil != nil && !now.Before(*durable.DrainUntil) {
		lifecycle = "archived"
	}
	if durable.LastSeen == nil || now.Sub(*durable.LastSeen) > HeartbeatTimeout {
		connection = "disconnected"
	}
	if activity == "unknown" && lifecycle == "active" && connection != "disconnected" {
		return "", false
	}
	if lifecycle != "active" || connection == "disconnected" {
		return model.SessionListWarning, true
	}
	if !synchronized || connection != "connected" {
		return model.SessionListPending, true
	}
	switch activity {
	case "waiting_input":
		return model.SessionListNotice, true
	case "idle", "stopped":
		return model.SessionListWarning, true
	case "working":
		return model.SessionListWorking, true
	default:
		return model.SessionListPending, true
	}
}
