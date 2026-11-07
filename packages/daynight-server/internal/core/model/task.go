package model

import "time"

type TaskStatus string

const (
	TaskTodo       TaskStatus = "todo"
	TaskInProgress TaskStatus = "in_progress"
	TaskDone       TaskStatus = "done"
	TaskCancelled  TaskStatus = "cancelled"
)

func (status TaskStatus) Valid() bool {
	return status == TaskTodo || status == TaskInProgress || status.IsTerminal()
}

func (status TaskStatus) IsTerminal() bool { return status == TaskDone || status == TaskCancelled }

func (status TaskStatus) SatisfiesDependency() bool { return status.IsTerminal() }

func (status TaskStatus) RequiresSatisfiedPrerequisites() bool {
	return status == TaskInProgress || status == TaskDone
}

func (status TaskStatus) IsExecutable() bool { return status == TaskTodo }

type Task struct {
	ID                string
	ProjectID         string
	Title             string
	Description       string
	Properties        TaskProperties
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
