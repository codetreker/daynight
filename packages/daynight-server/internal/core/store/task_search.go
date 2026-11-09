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
	Fence(context.Context, string) (TaskSearchFence, error)
	Matches(context.Context, string, TaskSearchQuery) (TaskSearchPage, error)
	MatchesEach(context.Context, string, TaskSearchQuery, func(int64, TaskSearchRow) (bool, error)) (int64, bool, error)
	ContextSize(context.Context, string, []string) (TaskSearchSize, error)
	ContextGraph(context.Context, string, []string) (TaskSearchGraph, error)
	ContextRepresentative(context.Context, string, string) (string, bool, error)
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
	Expression         *tasksearch.Node
	AssignedTo         model.TaskAssignmentFilter
	Status             *model.TaskStatus
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	After              *TaskSearchPosition
	Limit              int
}

type TaskSearchRow struct {
	ID, Title, Description string
	Status                 model.TaskStatus
	AssignedTo             *string
	CancelledAt            *time.Time
	UpdatedAt              time.Time
	ExactIDPriority        bool
	TitlePriority          bool
	// TitleOversized indicates that the full title cannot fit in a Search page.
	TitleOversized bool
	Hits           []TaskSearchHit
}

// TaskSearchHit is one atom's bounded evidence and description snippet.
type TaskSearchHit struct {
	Atom                   tasksearch.Atom
	ID, Title, Description bool
	Snippet                *string
}

type TaskSearchPage struct {
	Total   int64
	Items   []TaskSearchRow
	HasMore bool
}

type TaskSearchSize struct{ NodeCount, EdgeCount int64 }
type TaskSearchNode struct {
	ID        string
	CreatedAt time.Time
}
type TaskSearchEdge struct{ TaskID, DependsOnID string }
type TaskSearchGraph struct {
	Nodes []TaskSearchNode
	Edges []TaskSearchEdge
}
