package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
)

// TaskSearchReader keeps all search reads in one read-only repeatable snapshot.
type TaskSearchReader interface {
	ReadTaskSearch(context.Context, func(TaskSearchSnapshot) error) error
}

type TaskSearchSnapshot interface {
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
	ResolveTags(context.Context, string, []string) ([]model.Tag, error)
	Fence(context.Context, string) (TaskSearchFence, error)
	Matches(context.Context, string, TaskSearchQuery) (TaskSearchPage, error)
	ContextGraph(context.Context, string, []string) (TaskSearchGraph, error)
	Titles(context.Context, string, []string) (map[string]string, error)
}

type TaskSearchFence struct {
	Epoch, Count, VersionSum string
}

type TaskSearchPosition struct {
	ExactIDPriority bool
	TitlePriority   bool
	UpdatedAt       time.Time
	ID              string
}

type TaskSearchQuery struct {
	Type               model.TaskType
	Parent             *string
	Expression         *tasksearch.Node
	TagFilter          TagFilter
	AssignedTo         model.TaskAssignmentFilter
	Status             *model.TaskStatus
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	After              *TaskSearchPosition
	Limit              int
}

type TaskSearchRow struct {
	Tags                   []model.TagReference
	Type                   model.TaskType
	ParentID               *string
	ID, Title, Description string
	Status                 model.TaskStatus
	AssignedTo             *string
	CancelledAt            *time.Time
	UpdatedAt              time.Time
	ExactIDPriority        bool
	TitlePriority          bool
}

type TaskSearchPage struct {
	Total   int64
	Items   []TaskSearchRow
	HasMore bool
}

type TaskSearchNode struct {
	ID        string
	CreatedAt time.Time
}
type TaskSearchEdge struct{ TaskID, DependsOnID string }
type TaskSearchGraph struct {
	Nodes []TaskSearchNode
	Edges []TaskSearchEdge
}
