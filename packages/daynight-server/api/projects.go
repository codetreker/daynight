package api

import "time"

type CreateProjectRequest struct {
	Name           string  `json:"name"`
	RepoURL        string  `json:"repoUrl"`
	TeamID         *string `json:"teamId,omitempty"`
	ExpectedUserID string  `json:"expectedUserId"`
}

type ProjectSettings struct {
	Version                 int64 `json:"version"`
	ExecutionWarningMinutes int32 `json:"executionWarningMinutes"`
}

type UpdateProjectSettingsRequest struct {
	Version                 int64 `json:"version"`
	ExecutionWarningMinutes int32 `json:"executionWarningMinutes"`
}

type ProjectOwnership struct {
	TeamID  string `json:"teamId"`
	Version int64  `json:"version"`
}

type ProjectDocument struct {
	Project
	Access ProjectAccess `json:"access"`
}

type Project struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	RepoURL   string           `json:"repoUrl"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
	Settings  ProjectSettings  `json:"settings"`
	Ownership ProjectOwnership `json:"ownership"`
}

type ProjectPage struct {
	Items      []Project `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

type ErrorDetails struct {
	EncodedBytes    *int64   `json:"encodedBytes,omitempty"`
	MaxEncodedBytes *int64   `json:"maxEncodedBytes,omitempty"`
	TaskIDs         []string `json:"taskIds,omitempty"`
	NodeCount       *int64   `json:"nodeCount,omitempty"`
	EdgeCount       *int64   `json:"edgeCount,omitempty"`
	MaxNodes        *int64   `json:"maxNodes,omitempty"`
	MaxEdges        *int64   `json:"maxEdges,omitempty"`
}

type Error struct {
	Code      string        `json:"code"`
	Message   string        `json:"message"`
	RequestID string        `json:"requestId"`
	Details   *ErrorDetails `json:"details,omitempty"`
}

type ErrorResponse struct {
	Error Error `json:"error"`
}
