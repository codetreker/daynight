package api

import "time"

type PullRequestProperty struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

type TaskProperties struct {
	PullRequests []PullRequestProperty `json:"pullRequests"`
	Worker       *WorkerClaim          `json:"worker"`
}

type TaskWritableProperties struct {
	PullRequests []PullRequestProperty `json:"pullRequests"`
}

type TaskPropertiesPatch struct {
	PullRequests *[]PullRequestProperty `json:"pullRequests,omitempty"`
}

type CreateTaskRequest struct {
	RequiredPlatform  *string                `json:"requiredPlatform,omitempty"`
	ExternalDependsOn []string               `json:"externalDependsOn,omitempty"`
	Properties        TaskWritableProperties `json:"properties"`
	Title             string                 `json:"title"`
	Description       string                 `json:"description"`
	DependsOn         []string               `json:"dependsOn"`
}

type UpdateTaskRequest struct {
	RequiredPlatform  **string             `json:"requiredPlatform,omitempty"`
	ExternalDependsOn *[]string            `json:"externalDependsOn,omitempty"`
	AllowAgents       *bool                `json:"allowAgents,omitempty"`
	Properties        *TaskPropertiesPatch `json:"properties,omitempty"`
	Version           int64                `json:"version"`
	Title             *string              `json:"title,omitempty"`
	Description       *string              `json:"description,omitempty"`
	DependsOn         *[]string            `json:"dependsOn,omitempty"`
}

type TaskStatusUpdateRequest struct {
	Version int64   `json:"version"`
	Status  string  `json:"status"`
	ClaimID *string `json:"claimId,omitempty"`
}

type Task struct {
	Properties        TaskProperties `json:"properties"`
	ID                string         `json:"id"`
	ProjectID         string         `json:"projectId"`
	Title             string         `json:"title"`
	Description       string         `json:"description"`
	Status            string         `json:"status"`
	Version           int64          `json:"version"`
	CreatedAt         time.Time      `json:"createdAt"`
	UpdatedAt         time.Time      `json:"updatedAt"`
	StartedAt         *time.Time     `json:"startedAt"`
	CompletedAt       *time.Time     `json:"completedAt"`
	DependsOn         []string       `json:"dependsOn"`
	ExternalDependsOn []string       `json:"externalDependsOn"`
	BlockedBy         []string       `json:"blockedBy"`
	RequiredPlatform  *string        `json:"requiredPlatform"`
	AllowAgents       bool           `json:"allowAgents"`
	Ready             bool           `json:"ready"`
}

type TaskPage struct {
	Items      []Task  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}
