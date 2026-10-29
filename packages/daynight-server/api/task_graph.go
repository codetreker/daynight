package api

import "time"

type GraphTask struct {
	ID                   string     `json:"id"`
	TitlePreview         string     `json:"titlePreview"`
	TitleTruncated       bool       `json:"titleTruncated"`
	Status               string     `json:"status"`
	DependsOn            []string   `json:"dependsOn"`
	ExternalDependsOn    []string   `json:"externalDependsOn"`
	BlockedBy            []string   `json:"blockedBy"`
	RequiredPlatform     *string    `json:"requiredPlatform"`
	AllowAgents          bool       `json:"allowAgents"`
	WorkerNeedsAttention bool       `json:"workerNeedsAttention"`
	Ready                bool       `json:"ready"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
	StartedAt            *time.Time `json:"startedAt"`
	CompletedAt          *time.Time `json:"completedAt"`
}

type TaskGraphSummary struct {
	Total      int64 `json:"total"`
	Todo       int64 `json:"todo"`
	InProgress int64 `json:"inProgress"`
	Done       int64 `json:"done"`
	Ready      int64 `json:"ready"`
	Blocked    int64 `json:"blocked"`
}

type TaskGraph struct {
	Project    Project          `json:"project"`
	ObservedAt time.Time        `json:"observedAt"`
	Summary    TaskGraphSummary `json:"summary"`
	Tasks      []GraphTask      `json:"tasks"`
}
