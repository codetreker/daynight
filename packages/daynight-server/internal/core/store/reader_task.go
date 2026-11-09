package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TaskGraphSelection describes the graph projected from a root task.
type TaskGraphSelection struct {
	OrdinaryPrerequisites bool
	OrdinaryDependents    bool
	DirectExternal        bool
	LiveOnly              bool
}

// TaskStepProjection contains either the complete Step or a bounded title
// prefix and no description. TitleTruncated reports that the original title
// exceeds the requested preview size in bytes.
type TaskStepProjection struct {
	Step           model.TaskStep
	TitleTruncated bool
}

type TaskReader interface {
	Task(context.Context, string, string) (model.Task, error)
	Tasks(context.Context, string, TaskQuery) (TaskPage, error)
	TaskListFence(context.Context, string) (TaskListFence, error)
	TaskPriorityList(context.Context, string, TaskPriorityQuery) (TaskPriorityPage, error)
	TaskPresence(context.Context, string, string) (TaskPresence, error)
	TaskHeader(context.Context, string, string) (model.TaskHeader, error)
	TaskStep(context.Context, string, string) (model.TaskStep, error)
	TaskSteps(context.Context, string) ([]model.TaskStep, error)
	TaskStepPage(context.Context, string, int64, int, bool) ([]TaskStepProjection, error)
	TaskStepSummary(context.Context, string, string) (TaskStepProjection, error)
	ThreadMessage(context.Context, string, string) (model.ThreadMessage, error)
	ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
	TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error)
	ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error)
	TaskGraphTasks(context.Context, string, string, TaskGraphSelection, int) ([]model.GraphTask, error)
	TaskCacheEpoch(context.Context, string) (string, error)
	TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
}
