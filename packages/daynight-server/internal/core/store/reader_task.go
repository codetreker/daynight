package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TaskReader interface {
	Task(context.Context, string, string) (model.Task, error)
	Tasks(context.Context, string, TaskQuery) (TaskPage, error)
	TaskPresence(context.Context, string, string) (TaskPresence, error)
	TaskHeader(context.Context, string, string) (model.TaskHeader, error)
	TaskStep(context.Context, string, string) (model.TaskStep, error)
	TaskSteps(context.Context, string) ([]model.TaskStep, error)
	ThreadMessage(context.Context, string, string) (model.ThreadMessage, error)
	ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
	TaskAssignees(context.Context, string) (model.TaskAssignees, error)
	ResolveTaskAssignees(context.Context, string, []string) (model.TaskAssignees, error)
	TaskGraphSize(context.Context, string) (TaskGraphSize, error)
	TaskGraphRoot(context.Context, string, string) error
	TaskGraphProjectionSize(context.Context, string, string) (TaskGraphSize, error)
	TaskGraphTasks(context.Context, string, string, int) ([]model.GraphTask, error)
	TaskCacheEpoch(context.Context, string) (string, error)
	TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
}
