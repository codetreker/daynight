package task

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

type GraphReader interface {
	TaskPresence(context.Context, string, string) (store.TaskPresence, error)
	TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
}

type SnapshotClock func(context.Context) (time.Time, error)

func ReadGraph(ctx context.Context, reader GraphReader, clock SnapshotClock, projectID, taskID string, project model.Project) (model.TaskGraph, *model.Fault, error) {
	presence, err := reader.TaskPresence(ctx, projectID, taskID)
	if err != nil {
		return model.TaskGraph{}, nil, err
	}
	if fault := projection.GraphRoot(presence.Found, presence.DeletedAt != nil); fault != nil {
		return model.TaskGraph{}, fault, nil
	}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	tasks, err := reader.TaskGraphTasks(ctx, projectID, taskID, selection, projection.TitlePreviewCharacters)
	if err != nil {
		return model.TaskGraph{}, nil, err
	}
	observed, err := clock(ctx)
	if err != nil {
		return model.TaskGraph{}, nil, err
	}
	return model.TaskGraph{Project: project, Tasks: tasks, Summary: projection.SummarizeGraph(tasks), ObservedAt: observed}, nil, nil
}

type AssigneeReader interface {
	TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error)
	ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error)
}

func ReadAssignees(ctx context.Context, reader AssigneeReader, projectID string, userIDs []string) (model.TaskAssignees, error) {
	if userIDs == nil {
		facts, err := reader.TaskAssignees(ctx, projectID)
		if err != nil {
			return model.TaskAssignees{}, err
		}
		return projection.Catalogue(facts)
	}
	facts, err := reader.ResolveTaskAssignees(ctx, projectID, userIDs)
	if err != nil {
		return model.TaskAssignees{}, err
	}
	return projection.ResolveAssignees(userIDs, facts)
}

type SyncReader interface {
	TaskCacheEpoch(context.Context, string) (string, error)
	TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	TaskSyncDependencyStates(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
	TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error)
}

func ReadSync(ctx context.Context, reader SyncReader, clock SnapshotClock, projectID, requestedEpoch string, since *time.Time, overlap time.Duration, result model.TaskSync) (model.TaskSync, *model.Fault, error) {
	var err error
	result.Epoch, err = reader.TaskCacheEpoch(ctx, projectID)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	var lower *time.Time
	result.Mode, lower = projection.SyncWindow(requestedEpoch, result.Epoch, since, overlap)
	result.Tasks, err = reader.TaskSyncTasks(ctx, projectID, lower, projection.TitlePreviewCharacters)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	result.DependencyStates, err = reader.TaskSyncDependencyStates(ctx, projectID, lower)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	facts, err := reader.TaskAssignees(ctx, projectID)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	people, err := projection.Catalogue(facts)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	result.AssigneeVersions = projection.AssigneeVersions(people.Items)
	result.ObservedAt, err = clock(ctx)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	return result, nil, nil
}
