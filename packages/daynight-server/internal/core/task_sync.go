package core

import "time"

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
	AllowAgents       bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
}

type TaskSync struct {
	Mode       string
	Epoch      string
	Project    Project
	ObservedAt time.Time
	Tasks      []TaskViewRecord
}
