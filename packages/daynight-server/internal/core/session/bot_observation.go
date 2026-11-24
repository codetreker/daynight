package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ObserveBotSession samples an already authorized durable source without loading
// the Session browser or its parent credential. The caller owns Bot authorization
// and revalidation of the durable binding after this independent live sample.
func (s *Engine) ObserveBotSession(ctx context.Context, source *store.BotSessionSource) (store.BotSessionLive, error) {
	if err := ctx.Err(); err != nil {
		return store.BotSessionLive{}, err
	}
	op, err := s.BeginOperation()
	if err != nil {
		return store.BotSessionLive{}, err
	}
	defer op.Close()
	var sources []store.TaskSessionSource
	if source != nil && source.ServerInstance == s.instance {
		sources = []store.TaskSessionSource{{Session: &store.TaskSessionStateSource{SessionID: source.Snapshot.SessionID}}}
	}
	live, err := s.readTaskSessionLiveStates(ctx, op, sources)
	if err != nil {
		return store.BotSessionLive{}, err
	}
	result := store.BotSessionLive{ObservedAt: s.now().UTC()}
	if source != nil {
		if state := live[source.Snapshot.SessionID]; state != nil && state.Fence == source.Snapshot.ControllerFence {
			result.Fence = state.Fence
			result.ConnectionState, result.Synchronized, result.SourceSynced = state.ConnectionState, state.Synchronized, state.SourceSynced
			result.Activity, result.CurrentTurnID, result.Available = state.Activity, state.CurrentTurnID, true
		}
	}
	if err := taskSessionReadAdmission(ctx, op); err != nil {
		return store.BotSessionLive{}, err
	}
	return result, nil
}
