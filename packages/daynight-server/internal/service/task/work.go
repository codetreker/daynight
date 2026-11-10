package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
)

func (s *Observations) WorkList(ctx context.Context, principal model.Principal, projectID string, request taskcore.WorkRequest) (taskwork.Page, error) {
	projectID, err := observationIdentity(principal, projectID)
	if err != nil {
		return taskwork.Page{}, err
	}
	selection, err := taskcore.SelectWork(projectID, principal.UserID, request)
	if err != nil {
		return taskwork.Page{}, err
	}
	if request.ResponseOverhead < 0 || request.ResponseOverhead >= taskwork.MaxResponseBytes {
		return taskwork.Page{}, &model.Fault{Code: "resource_limit_exceeded", Message: "The work overview response envelope exceeds its limit."}
	}
	result := taskwork.Page{Groups: []taskwork.Group{}}
	var fence store.TaskSearchFence
	var groups store.TaskWorkGroups
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		fence, err = workFence(ctx, snapshot.TaskDAO(), projectID)
		if err != nil {
			return err
		}
		if err := selection.CheckFence(fence); err != nil {
			return err
		}
		groups, err = snapshot.TaskDAO().TaskWorkGroups(ctx, projectID, selection.Query)
		if err != nil {
			return err
		}
		if selection.Query.GroupID != nil && len(groups.Items) == 0 {
			return changedWorkGraph()
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return taskwork.Page{}, fmt.Errorf("select task work overview: %w", err)
	}
	ids := make([]string, len(groups.Items))
	indexes := make(map[string]int, len(groups.Items))
	positions := make(map[string]store.TaskWorkPosition, len(groups.Items))
	for i, group := range groups.Items {
		ids[i] = group.ID
		indexes[group.ID] = i
		positions[group.ID] = store.TaskWorkPosition{GroupID: group.ID, StartedAt: group.StartedAt}
		result.Groups = append(result.Groups, taskcore.ProjectWorkGroup(group, selection.Query.AssignedTo, result.ObservedAt))
	}
	if groups.HasMore && len(groups.Items) > 0 {
		cursor, err := selection.CursorAfter(fence, positions[groups.Items[len(groups.Items)-1].ID])
		if err != nil {
			return taskwork.Page{}, err
		}
		result.NextCursor = &cursor
	}
	var after *store.TaskWorkTargetPosition
	for len(ids) > 0 {
		var targets store.TaskWorkTargets
		var selected []model.Task
		var sources store.SnapshotScope
		err := s.readWorkSnapshot(ctx, principal, projectID, fence, func(snapshot store.SnapshotScope) error {
			var err error
			targets, err = snapshot.TaskDAO().TaskWorkTargets(ctx, projectID, ids, after, 200)
			if err != nil {
				return err
			}
			selected = make([]model.Task, len(targets.Items))
			for i, item := range targets.Items {
				selected[i] = item.Task
			}
			sources, err = loadSelectedSources(ctx, snapshot, projectID, selected)
			return err
		})
		if err != nil {
			return taskwork.Page{}, fmt.Errorf("read task work targets: %w", err)
		}
		observations, partial, err := s.observeBatch(ctx, sources, principal, projectID, selected, result.ObservedAt)
		if err != nil {
			return taskwork.Page{}, err
		}
		result.Partial = result.Partial || partial
		for _, item := range targets.Items {
			index, exists := indexes[item.GroupID]
			if !exists {
				return taskwork.Page{}, fmt.Errorf("work target belongs to an unselected group")
			}
			group := &result.Groups[index]
			observation := observations[item.Task.ID]
			taskcore.AddSessionObservation(&group.Summary, observation)
			if selection.AfterTarget != nil && item.Task.ID <= selection.AfterTarget.TaskID {
				continue
			}
			if len(group.Targets) < 20 {
				group.Targets = append(group.Targets, taskcore.ProjectWorkTarget(item.Task, selection.Query.AssignedTo, observation))
			} else if group.ContributorCursor == nil {
				cursor, err := selection.TargetCursor(fence, store.TaskWorkTargetPosition{GroupID: group.GroupID, TaskID: group.Targets[len(group.Targets)-1].TaskID})
				if err != nil {
					return taskwork.Page{}, err
				}
				group.ContributorCursor = &cursor
			}
		}
		if !targets.HasMore {
			break
		}
		if len(targets.Items) == 0 {
			return taskwork.Page{}, fmt.Errorf("work target continuation did not advance")
		}
		last := targets.Items[len(targets.Items)-1]
		next := store.TaskWorkTargetPosition{GroupID: last.GroupID, TaskID: last.Task.ID}
		if after != nil && (next.GroupID < after.GroupID || next.GroupID == after.GroupID && next.TaskID <= after.TaskID) {
			return taskwork.Page{}, fmt.Errorf("work target continuation did not advance")
		}
		after = &next
	}
	// No transaction spans live sampling. Rechecking the graph after the final
	// batch also prevents publishing a partial traversal of a changed component.
	if err := s.readWorkSnapshot(ctx, principal, projectID, fence, nil); err != nil {
		return taskwork.Page{}, err
	}
	return taskcore.FitWorkPage(result, selection, fence, positions, taskwork.MaxResponseBytes-request.ResponseOverhead)
}

func workFence(ctx context.Context, reader store.TaskReader, projectID string) (store.TaskSearchFence, error) {
	epoch, err := reader.TaskCacheEpoch(ctx, projectID)
	if err != nil {
		return store.TaskSearchFence{}, err
	}
	stamp, err := reader.TaskListFence(ctx, projectID)
	return store.TaskSearchFence{Epoch: epoch, Count: stamp.Count, VersionSum: stamp.VersionSum}, err
}
func changedWorkGraph() error {
	return &model.Fault{Code: "reset_required", Message: "The work graph changed; restart the overview."}
}
func (s *Observations) readWorkSnapshot(ctx context.Context, principal model.Principal, projectID string, expected store.TaskSearchFence, read func(store.SnapshotScope) error) error {
	return s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		actual, err := workFence(ctx, snapshot.TaskDAO(), projectID)
		if err != nil {
			return err
		}
		if actual != expected {
			return changedWorkGraph()
		}
		if read != nil {
			return read(snapshot)
		}
		return nil
	})
}
