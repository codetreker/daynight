package store

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type Position struct {
	CreatedAt time.Time
	ID        string
}

type Page struct {
	After *Position
	Limit int
}

type ProjectPage struct {
	Items   []model.Project
	HasMore bool
}

type WorkerQuery struct {
	UserID   string
	WorkerID string
}

type TaskQuery struct {
	TagFilter          TagFilter
	Type               model.TaskType
	Parent             *string
	AssignedTo         model.TaskAssignmentFilter
	Page               Page
	Status             *model.TaskStatus
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	PlatformSpecific   *bool
	AutomaticCandidate bool
	Worker             *WorkerQuery
}

type TaskPage struct {
	Items   []model.Task
	HasMore bool
}

// TaskListFence covers every task header in a project, including deleted rows.
type TaskListFence struct{ Count, VersionSum string }

type TaskPriorityPosition struct {
	Group     int
	CreatedAt time.Time
	ID        string
}

// TaskPriorityQuery applies all filters before priority ordering and limiting.
type TaskPriorityQuery struct {
	TagFilter          TagFilter
	Type               model.TaskType
	Parent             *string
	AssignedTo         model.TaskAssignmentFilter
	Status             *model.TaskStatus
	ExcludeTerminal    bool
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	After              *TaskPriorityPosition
	Limit              int
}

type TaskPriorityItem struct {
	Task           model.Task
	BlockedByCount int
	TitleTruncated bool
}

type TaskPriorityPage struct {
	Items   []TaskPriorityItem
	HasMore bool
}
