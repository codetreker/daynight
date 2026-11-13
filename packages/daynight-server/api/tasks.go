package api

import (
	"encoding/json"

	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type PullRequestProperty struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

type TaskProperties = map[string]json.RawMessage

type TaskWritableProperties = TaskProperties

type TaskPropertiesPatch = TaskProperties

type PropertyResource struct {
	ProjectID  string         `json:"projectId"`
	TaskID     string         `json:"taskId"`
	Version    int64          `json:"version"`
	Properties TaskProperties `json:"properties"`
}

type TaskPropertyDefinition struct {
	Description string          `json:"description"`
	ReadOnly    bool            `json:"readOnly"`
	Schema      json.RawMessage `json:"schema"`
}

type TaskPropertySchema struct {
	Properties map[string]TaskPropertyDefinition `json:"properties"`
}

type CreateTaskRequest struct {
	TagIDs                  *[]string              `json:"tagIds,omitempty"`
	Type                    *string                `json:"type,omitempty"`
	ParentID                **string               `json:"parentId,omitempty"`
	AssignedToPresent       bool                   `json:"-"`
	RequiredPlatformPresent bool                   `json:"-"`
	Status                  *string                `json:"status,omitempty"`
	AssignedTo              *string                `json:"assignedTo,omitempty"`
	RequiredPlatform        *string                `json:"requiredPlatform,omitempty"`
	ExternalDependsOn       []string               `json:"externalDependsOn,omitempty"`
	Properties              TaskWritableProperties `json:"properties"`
	Title                   string                 `json:"title"`
	Description             string                 `json:"description"`
	DependsOn               []string               `json:"dependsOn"`
}

type UpdateTaskRequest struct {
	ParentID          **string             `json:"parentId,omitempty"`
	AssignedTo        **string             `json:"assignedTo,omitempty"`
	RequiredPlatform  **string             `json:"requiredPlatform,omitempty"`
	ExternalDependsOn *[]string            `json:"externalDependsOn,omitempty"`
	AllowAgents       *bool                `json:"allowAgents,omitempty"`
	Properties        *TaskPropertiesPatch `json:"properties,omitempty"`
	Version           int64                `json:"version"`
	Title             *string              `json:"title,omitempty"`
	Description       *string              `json:"description,omitempty"`
	DependsOn         *[]string            `json:"dependsOn,omitempty"`
	TagIDs            *[]string            `json:"tagIds,omitempty"`
}

type TaskDeleteRequest struct {
	Version       int64 `json:"version"`
	RemoveDepends bool  `json:"removeDepends,omitempty"`
}

type TaskStatusUpdateRequest struct {
	Version int64   `json:"version"`
	Status  string  `json:"status"`
	ClaimID *string `json:"claimId,omitempty"`
}

type Task = taskprotocol.REST

type TaskPage struct {
	Items      []Task  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}
