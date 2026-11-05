package api

import "time"

type TaskSearchRequest struct {
	Query              string  `json:"query"`
	AssignedTo         *string `json:"assignedTo,omitempty"`
	Status             *string `json:"status,omitempty"`
	Ready              *bool   `json:"ready,omitempty"`
	AllowAgents        *bool   `json:"allowAgents,omitempty"`
	CompatiblePlatform *string `json:"compatiblePlatform,omitempty"`
	Limit              *int    `json:"limit,omitempty"`
	Cursor             *string `json:"cursor,omitempty"`
}

type TaskSearchContext struct {
	TaskID string `json:"taskId"`
	Title  string `json:"title"`
}
type TaskSearchMatch struct {
	Fields             []string `json:"fields"`
	DescriptionSnippet *string  `json:"descriptionSnippet"`
}
type TaskSearchItem struct {
	ID         string             `json:"id"`
	ProjectID  string             `json:"projectId"`
	Title      string             `json:"title"`
	Status     string             `json:"status"`
	AssignedTo *string            `json:"assignedTo"`
	UpdatedAt  time.Time          `json:"updatedAt"`
	Context    *TaskSearchContext `json:"context"`
	Match      TaskSearchMatch    `json:"match"`
}
type TaskSearchPage struct {
	ProjectID  string           `json:"projectId"`
	Total      int64            `json:"total"`
	Items      []TaskSearchItem `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}
