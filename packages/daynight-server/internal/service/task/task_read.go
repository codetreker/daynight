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

// TaskObservation binds a complete task to the project history observed with it.
type TaskObservation struct {
	Task  model.Task
	Epoch string
}

func (s *Tasks) Get(ctx context.Context, principal model.Principal, projectID, id string) (model.Task, error) {
	observation, err := s.read(ctx, principal, projectID, id, false)
	return observation.Task, err
}

func (s *Tasks) Observe(ctx context.Context, principal model.Principal, projectID, id string) (TaskObservation, error) {
	return s.read(ctx, principal, projectID, id, true)
}

func (s *Tasks) read(ctx context.Context, principal model.Principal, projectID, id string, withEpoch bool) (TaskObservation, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TaskObservation{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return TaskObservation{}, err
	}
	id, err = model.CanonicalID(id)
	if err != nil {
		return TaskObservation{}, err
	}
	var result TaskObservation
	var missing *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		reader := snapshot.TaskDAO()
		result.Task, missing, err = taskcore.ReadTask(ctx, reader, projectID, id)
		if err != nil || missing != nil {
			return err
		}
		values := []model.Task{result.Task}
		if err = decorateGoalProgress(ctx, reader, projectID, values); err != nil {
			return err
		}
		result.Task = values[0]
		if !withEpoch {
			return err
		}
		result.Epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, projectID)
		return err
	})
	if err != nil {
		return TaskObservation{}, fmt.Errorf("get task: %w", err)
	}
	if missing != nil {
		return TaskObservation{}, missing
	}
	return result, nil
}

func (s *Tasks) List(ctx context.Context, principal model.Principal, projectID string, request TaskListRequest) (TaskPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TaskPage{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return TaskPage{}, err
	}
	selection, err := taskcore.SelectList(projectID, principal.UserID, taskcore.ListRequest{
		TagFilter: request.TagFilter, PageRequest: request.PageRequest, Type: request.Type, Parent: request.Parent, AssignedTo: request.AssignedTo, Status: request.Status, Ready: request.Ready,
		AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, AutomaticCandidate: request.AutomaticCandidate, WorkerID: request.WorkerID,
	})
	if err != nil {
		return TaskPage{}, err
	}
	var result store.TaskPage
	var missing *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := s.listOperations.requireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		reader := snapshot.TaskDAO()
		if len(selection.Query.TagFilter.TagIDs) != 0 {
			if err := taskcore.RequireTagFilter(ctx, snapshot.TagDAO(), projectID, selection.Query.TagFilter); err != nil {
				return err
			}
		}
		result, missing, err = s.listOperations.readList(ctx, reader, projectID, selection)
		if err != nil || missing != nil {
			return err
		}
		return decorateGoalProgress(ctx, reader, projectID, result.Items)
	})
	if err != nil {
		return TaskPage{}, fmt.Errorf("list tasks: %w", err)
	}
	if missing != nil {
		return TaskPage{}, missing
	}
	page, err := taskcore.ProjectList(selection, result)
	if err != nil {
		return TaskPage{}, err
	}
	return TaskPage{Items: page.Items, NextCursor: page.NextCursor}, nil
}
