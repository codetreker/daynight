package task

import (
	"context"
	"errors"
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
	TaskSyncCoverageUpdatedAt(context.Context, string) (*time.Time, error)
	TaskSyncDeletedTaskIDs(context.Context, string, *time.Time) ([]string, error)
	TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	TaskSyncGoalDependsOn(context.Context, string, []string) (map[string][]string, error)
	TaskSyncDependencyStates(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
	TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error)
}

type syncFailurePhase uint8

const (
	syncCoverageRead syncFailurePhase = iota + 1
	syncDeletionRead
	syncProjectionValidation
)

type syncFailure struct {
	phase syncFailurePhase
	cause error
}

func (failure *syncFailure) Error() string { return "task sync read failed" }
func (failure *syncFailure) Unwrap() error { return failure.cause }

// SyncFailurePhase exposes only the fixed diagnostic stages of a sync failure.
func SyncFailurePhase(err error) string {
	var failure *syncFailure
	if !errors.As(err, &failure) {
		return ""
	}
	switch failure.phase {
	case syncCoverageRead:
		return "coverage_read"
	case syncDeletionRead:
		return "deletion_read"
	case syncProjectionValidation:
		return "projection_validation"
	default:
		return ""
	}
}

func ReadSync(ctx context.Context, reader SyncReader, clock SnapshotClock, projectID, requestedEpoch string, since *time.Time, overlap time.Duration, result model.TaskSync) (model.TaskSync, *model.Fault, error) {
	var err error
	result.Epoch, err = reader.TaskCacheEpoch(ctx, projectID)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	var lower *time.Time
	result.Mode, lower = projection.SyncWindow(requestedEpoch, result.Epoch, since, overlap)
	result.CoverageUpdatedAt, err = reader.TaskSyncCoverageUpdatedAt(ctx, projectID)
	if err != nil {
		return model.TaskSync{}, nil, &syncFailure{phase: syncCoverageRead, cause: err}
	}
	result.DeletedTaskIDs = []string{}
	if result.Mode == "delta" {
		result.DeletedTaskIDs, err = reader.TaskSyncDeletedTaskIDs(ctx, projectID, lower)
		if err != nil {
			return model.TaskSync{}, nil, &syncFailure{phase: syncDeletionRead, cause: err}
		}
		if result.DeletedTaskIDs == nil {
			return model.TaskSync{}, nil, &syncFailure{phase: syncProjectionValidation, cause: errors.New("task sync deletion reader returned nil IDs")}
		}
	}
	result.Tasks, err = reader.TaskSyncTasks(ctx, projectID, lower, projection.TitlePreviewCharacters)
	if err != nil {
		return model.TaskSync{}, nil, err
	}
	deleted := make(map[string]struct{}, len(result.DeletedTaskIDs))
	for i, id := range result.DeletedTaskIDs {
		canonical, idErr := model.CanonicalID(id)
		if idErr != nil || canonical != id || (i > 0 && result.DeletedTaskIDs[i-1] >= id) {
			return model.TaskSync{}, nil, &syncFailure{phase: syncProjectionValidation, cause: errors.New("task sync deletion reader returned invalid IDs")}
		}
		deleted[id] = struct{}{}
	}
	for _, task := range result.Tasks {
		if _, ok := deleted[task.ID]; ok || result.CoverageUpdatedAt == nil || task.UpdatedAt.After(*result.CoverageUpdatedAt) {
			return model.TaskSync{}, nil, &syncFailure{phase: syncProjectionValidation, cause: errors.New("task sync projection does not match coverage")}
		}
	}
	var goalIDs []string
	for _, task := range result.Tasks {
		if task.Type == model.TaskTypeGoal {
			goalIDs = append(goalIDs, task.ID)
		}
	}
	if len(goalIDs) != 0 {
		prerequisites, err := reader.TaskSyncGoalDependsOn(ctx, projectID, goalIDs)
		if err != nil {
			return model.TaskSync{}, nil, err
		}
		for i := range result.Tasks {
			if result.Tasks[i].Type == model.TaskTypeGoal {
				result.Tasks[i].DependsOn = prerequisites[result.Tasks[i].ID]
			}
		}
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
