package model

import "time"

type TaskType string

const (
	TaskTypeTask TaskType = "task"
	TaskTypeGoal TaskType = "goal"
)

type TaskStatus string

const (
	TaskProposed   TaskStatus = "proposed"
	TaskTodo       TaskStatus = "todo"
	TaskInProgress TaskStatus = "in_progress"
	TaskDone       TaskStatus = "done"
	TaskCancelled  TaskStatus = "cancelled"
)

func (status TaskStatus) Valid() bool {
	return status == TaskProposed || status == TaskTodo || status == TaskInProgress || status.IsTerminal()
}

func (status TaskStatus) IsTerminal() bool { return status == TaskDone || status == TaskCancelled }

func (status TaskStatus) SatisfiesDependency() bool { return status.IsTerminal() }

func (status TaskStatus) RequiresSatisfiedPrerequisites() bool {
	return status == TaskInProgress || status == TaskDone
}

func (status TaskStatus) IsExecutable() bool { return status == TaskTodo }

type GoalProgress struct {
	Total      int64 `json:"total"`
	Done       int64 `json:"done"`
	Cancelled  int64 `json:"cancelled"`
	Unfinished int64 `json:"unfinished"`
}

type Task struct {
	Progress          *GoalProgress
	Type              TaskType
	ParentID          *string
	ID                string
	ProjectID         string
	Title             string
	Description       string
	Properties        TaskProperties
	Tags              []TagReference
	Status            TaskStatus
	Version           int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	CancelledAt       *time.Time
	DependsOn         []string
	ExternalDependsOn []string
	BlockedBy         []string
	RequiredPlatform  *TaskPlatform
	AssignedTo        *string
	AllowAgents       bool
	Ready             bool
}

// TaskTombstone is the authoritative result of a successful soft deletion.
type TaskTombstone struct {
	ProjectID string
	ID        string
	Version   int64
	DeletedAt time.Time
}
