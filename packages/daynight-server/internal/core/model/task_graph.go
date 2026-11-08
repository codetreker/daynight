package model

import "time"

type GraphTask struct {
	ID                string
	TitlePreview      string
	TitleTruncated    bool
	Status            TaskStatus
	DependsOn         []string
	ExternalDependsOn []string
	BlockedBy         []string
	RequiredPlatform  *TaskPlatform
	AssignedTo        *string
	AllowAgents       bool
	Ready             bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	CancelledAt       *time.Time
}

type TaskGraphSummary struct {
	Total      int64
	Todo       int64
	InProgress int64
	Done       int64
	Cancelled  int64
	Ready      int64
	Blocked    int64
}

type TaskGraph struct {
	Project    Project
	ObservedAt time.Time
	Summary    TaskGraphSummary
	Tasks      []GraphTask
}
