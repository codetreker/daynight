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

// MCPList visits the requested page in one authorized snapshot. Returning false
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
		if len(selection.TagFilter().TagIDs) != 0 {
			if err := taskcore.RequireTagFilter(ctx, snapshot.TagDAO(), projectID, selection.TagFilter()); err != nil {
				return err
			}
		}
		page, err := taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), projectID, selection)
		if err != nil {
			return err
		}
		if request.View == "full" {
			if err := expandPriorityPage(ctx, snapshot.TaskDAO(), projectID, page.Items); err != nil {
				return err
			}
		}
		for i, item := range page.Items {
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

// MCPReady reads the first candidates in one authorized snapshot, without a
// continuation fence or cursor. Full items are read from that same snapshot.
func (s *Tasks) MCPReady(ctx context.Context, principal model.Principal, projectID string, request taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return nil, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return nil, err
	}
	query, err := taskcore.SelectMCPReady(request)
	if err != nil {
		return nil, err
	}
	var items []store.TaskPriorityItem
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		if len(query.TagFilter.TagIDs) != 0 {
			if err := taskcore.RequireTagFilter(ctx, snapshot.TagDAO(), projectID, query.TagFilter); err != nil {
				return err
			}
		}
		page, err := snapshot.TaskDAO().TaskPriorityList(ctx, projectID, query)
		if err != nil {
			return err
		}
		items = page.Items
		if request.View == "full" {
			if err := expandPriorityPage(ctx, snapshot.TaskDAO(), projectID, items); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read MCP ready tasks: %w", err)
	}
	if refusal != nil {
		return nil, refusal
	}
	return items, nil
}
