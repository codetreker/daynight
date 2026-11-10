package api

import "time"

type GraphTask struct {
	ID                string     `json:"id"`
	TitlePreview      string     `json:"titlePreview"`
	TitleTruncated    bool       `json:"titleTruncated"`
	Status            string     `json:"status"`
	DependsOn         []string   `json:"dependsOn"`
	ExternalDependsOn []string   `json:"externalDependsOn"`
	BlockedBy         []string   `json:"blockedBy"`
	RequiredPlatform  *string    `json:"requiredPlatform"`
	AssignedTo        *string    `json:"assignedTo"`
	AllowAgents       bool       `json:"allowAgents"`
	Ready             bool       `json:"ready"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
	StartedAt         *time.Time `json:"startedAt"`
	CompletedAt       *time.Time `json:"completedAt"`
	CancelledAt       *time.Time `json:"cancelledAt"`
}

type TaskGraphSummary struct {
	Total      int64 `json:"total"`
	Proposed   int64 `json:"proposed"`
	Todo       int64 `json:"todo"`
	InProgress int64 `json:"inProgress"`
	Done       int64 `json:"done"`
	Cancelled  int64 `json:"cancelled"`
	Ready      int64 `json:"ready"`
	Blocked    int64 `json:"blocked"`
}

type TaskGraph struct {
	Project    Project          `json:"project"`
	ObservedAt time.Time        `json:"observedAt"`
	Summary    TaskGraphSummary `json:"summary"`
	Tasks      []GraphTask      `json:"tasks"`
}
