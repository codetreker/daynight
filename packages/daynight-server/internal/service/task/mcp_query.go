package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

// MCPList visits bounded projections in one authorized snapshot. Returning false
// stops before the current item; the caller retains its last accepted cursor.
func (s *Tasks) MCPList(ctx context.Context, principal model.Principal, projectID string, request taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return err
	}
	selection, err := taskcore.SelectMCPList(projectID, principal.UserID, request)
	if err != nil {
		return err
	}
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		page, err := taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), projectID, selection)
		if err != nil {
			return err
		}
		for i, item := range page.Items {
			if request.View == "full" {
				full, err := snapshot.TaskDAO().Task(ctx, projectID, item.Task.ID)
				if err != nil {
					return err
				}
				item.Task = full
			}
			more := i+1 < len(page.Items) || page.HasMore
			cursor, err := page.CursorAfter(selection, item.Task)
			if err != nil {
				return err
			}
			if !visit(item, cursor, more) {
				return nil
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("list MCP tasks: %w", err)
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
