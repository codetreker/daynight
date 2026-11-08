package model

import "time"

type SessionListState string

const (
	SessionListWorking SessionListState = "working"
	SessionListNotice  SessionListState = "notice"
	SessionListWarning SessionListState = "warning"
	SessionListPending SessionListState = "pending"
)

type TaskViewRecord struct {
	Properties        TaskProperties
	ID                string
	TitlePreview      string
	TitleTruncated    bool
	Status            TaskStatus
	Version           int64
	DependsOn         []string
	ExternalDependsOn []string
	RequiredPlatform  *TaskPlatform
	AssignedTo        *string
	AllowAgents       bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	CancelledAt       *time.Time
}

type TaskSync struct {
	Mode             string
	Epoch            string
	Project          Project
	ActorAccess      ProjectAccess
	ObservedAt       time.Time
	Tasks            []TaskViewRecord
	AssigneeVersions []TaskAssigneeVersion
	Sessions         map[string]SessionListState
}
