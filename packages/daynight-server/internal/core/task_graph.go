package core

import "time"

type GraphTask struct {
	ID                   string
	TitlePreview         string
	TitleTruncated       bool
	Status               TaskStatus
	DependsOn            []string
	ExternalDependsOn    []string
	BlockedBy            []string
	RequiredPlatform     *TaskPlatform
	AllowAgents          bool
	WorkerNeedsAttention bool
	Ready                bool
	CreatedAt            time.Time
	UpdatedAt            time.Time
	StartedAt            *time.Time
	CompletedAt          *time.Time
}

type TaskGraphSummary struct {
	Total      int64
	Todo       int64
	InProgress int64
	Done       int64
	Ready      int64
	Blocked    int64
}

type TaskGraph struct {
	Project    Project
	ObservedAt time.Time
	Summary    TaskGraphSummary
	Tasks      []GraphTask
}
