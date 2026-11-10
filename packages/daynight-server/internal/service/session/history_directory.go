package session

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (s *History) Current(ctx context.Context, p model.Principal, project, task string) (sp.TaskSessionCurrent, error) {
	identity, err := s.backend.TaskCurrentIdentity(ctx, p, project, task)
	if err != nil {
		return sp.TaskSessionCurrent{}, fmt.Errorf("read current task session identity: %w", err)
	}
	result := sp.TaskSessionCurrent{Status: identity.Status, ClaimID: identity.ClaimID, AgentControlMode: identity.AgentControlMode}
	if identity.SessionID == nil {
		return result, nil
	}
	inspection, err := s.inspection.Inspect(ctx, p, project, task, *identity.SessionID)
	if err != nil {
		return sp.TaskSessionCurrent{}, fmt.Errorf("inspect current task session: %w", err)
	}
	if !inspection.CurrentBinding || inspection.SessionID != *identity.SessionID || identity.ClaimID == nil || inspection.Fence.ClaimID != *identity.ClaimID {
		return sp.TaskSessionCurrent{}, &model.Fault{Code: "execution_changed", Message: "The current Task execution changed during inspection; read its current association again."}
	}
	result.Session = &inspection
	return result, nil
}

func (s *History) List(ctx context.Context, p model.Principal, project, task, cursor string, limit int) (sp.TaskSessionList, error) {
	// The domain directory selects the page and current binding in one scope;
	// observing each row separately would mix claims and introduce an N+1 read.
	page, err := s.backend.TaskDirectory(ctx, p, project, task, cursor, limit)
	if err != nil {
		return sp.TaskSessionList{}, fmt.Errorf("read task session directory: %w", err)
	}
	return page, nil
}
