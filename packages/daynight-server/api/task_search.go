package api

import (
	"time"

	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type TaskSearchRequest struct {
	Query              string   `json:"query"`
	AssignedTo         *string  `json:"assignedTo,omitempty"`
	Status             *string  `json:"status,omitempty"`
	Ready              *bool    `json:"ready,omitempty"`
	AllowAgents        *bool    `json:"allowAgents,omitempty"`
	CompatiblePlatform *string  `json:"compatiblePlatform,omitempty"`
	Limit              *int     `json:"limit,omitempty"`
	Cursor             *string  `json:"cursor,omitempty"`
	TagIDs             []string `json:"tagIds,omitempty"`
	TagMatch           *string  `json:"tagMatch,omitempty"`
	Untagged           *bool    `json:"untagged,omitempty"`
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
	ID          string                          `json:"id"`
	Type        string                          `json:"type"`
	ParentID    *string                         `json:"parentId"`
	ProjectID   string                          `json:"projectId"`
	Title       string                          `json:"title"`
	Status      string                          `json:"status"`
	AssignedTo  *string                         `json:"assignedTo"`
	UpdatedAt   time.Time                       `json:"updatedAt"`
	CancelledAt *time.Time                      `json:"cancelledAt"`
	Context     *TaskSearchContext              `json:"context"`
	Match       TaskSearchMatch                 `json:"match"`
	Tags        []taskprotocol.RESTTagReference `json:"tags"`
}
type TaskSearchPage struct {
	ProjectID  string           `json:"projectId"`
	Total      int64            `json:"total"`
	Items      []TaskSearchItem `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}
