package model

import "time"

type TaskStatus string

const (
	TaskTodo       TaskStatus = "todo"
	TaskInProgress TaskStatus = "in_progress"
	TaskDone       TaskStatus = "done"
)

func (status TaskStatus) Valid() bool {
	return status == TaskTodo || status == TaskInProgress || status == TaskDone
}

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
	DependsOn         []string
	ExternalDependsOn []string
	BlockedBy         []string
	RequiredPlatform  *TaskPlatform
	AssignedTo        *string
	AllowAgents       bool
	Ready             bool
}
