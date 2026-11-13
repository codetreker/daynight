package task

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type MCPListRequest struct {
	TagFilter          store.TagFilter
	Type               model.TaskType
	Parent             *string
	All                bool
	Status             *model.TaskStatus
	AssignedTo         *string
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	Limit              int
	Cursor             *string
	View               string
}

type mcpListScope struct {
	TagFilterIdentity  string                     `json:"tagFilter"`
	Version            int                        `json:"version"`
	Kind               string                     `json:"kind"`
	Order              string                     `json:"order"`
	Actor              string                     `json:"actor"`
	Project            string                     `json:"project"`
	Type               model.TaskType             `json:"type"`
	Parent             *string                    `json:"parent"`
	All                bool                       `json:"all"`
	Status             *model.TaskStatus          `json:"status"`
	AssignedTo         model.TaskAssignmentFilter `json:"assignedTo"`
	AssignmentSource   *string                    `json:"assignmentSource"`
	Ready              *bool                      `json:"ready"`
	AllowAgents        *bool                      `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform        `json:"compatiblePlatform"`
	View               string                     `json:"view"`
}
type mcpListCursor struct {
	Scope    mcpListScope               `json:"scope"`
	Fence    store.TaskListFence        `json:"fence"`
	Position store.TaskPriorityPosition `json:"position"`
}
type MCPListSelection struct {
	scope mcpListScope
	query store.TaskPriorityQuery
	prior *mcpListCursor
}

func (selection MCPListSelection) TagFilter() store.TagFilter { return selection.query.TagFilter }

type MCPListPage struct {
	Items   []store.TaskPriorityItem
	HasMore bool
	fence   store.TaskListFence
}

func mcpInvalidCursor() error {
	return &model.Fault{Code: "invalid_input", Message: "Cursor is invalid for this task list."}
}
func mcpDecimal(s string) bool {
	if s == "" || len(s) > 1 && s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func SelectMCPList(projectID, principalUserID string, request MCPListRequest) (MCPListSelection, error) {
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return MCPListSelection{}, err
	}
	principalUserID, err = model.CanonicalID(principalUserID)
	if err != nil {
		return MCPListSelection{}, err
	}
	kind, parent, err := ResourceFilter(request.Type, request.Parent)
	if err != nil {
		return MCPListSelection{}, err
	}
	if request.Limit < 1 || request.Limit > 100 {
		return MCPListSelection{}, invalidInput("Limit must be between 1 and 100.")
	}
	if request.All && request.Status != nil {
		return MCPListSelection{}, invalidInput("all and status cannot be combined.")
	}
	if request.Status != nil && !request.Status.Valid() {
		return MCPListSelection{}, invalidInput("Task status is invalid.")
	}
	if request.CompatiblePlatform != nil && !request.CompatiblePlatform.Valid() {
		return MCPListSelection{}, invalidInput("Compatible platform must be windows, linux or macos.")
	}
	if request.View == "" {
		request.View = "summary"
	}
	if request.View != "summary" && request.View != "full" {
		return MCPListSelection{}, invalidInput("Task view is invalid.")
	}
	assignment, err := AssignmentFilter(request.AssignedTo, principalUserID)
	if err != nil {
		return MCPListSelection{}, err
	}
	filter, err := NormalizeTagFilter(request.TagFilter)
	if err != nil {
		return MCPListSelection{}, err
	}
	scope := mcpListScope{TagFilterIdentity: TagFilterIdentity(filter), Version: 3, Kind: "task_list", Order: "priority_created_id", Actor: principalUserID, Project: projectID, Type: kind, Parent: parent, All: request.All, Status: request.Status, AssignedTo: assignment, AssignmentSource: request.AssignedTo, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, View: request.View}
	selection := MCPListSelection{scope: scope, query: store.TaskPriorityQuery{TagFilter: filter, Type: kind, Parent: parent, AssignedTo: assignment, Status: request.Status, ExcludeTerminal: !request.All && request.Status == nil, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, Limit: request.Limit}}
	if request.Cursor != nil {
		if len(*request.Cursor) > transport.MaxEncodedCursorBytes {
			return MCPListSelection{}, mcpInvalidCursor()
		}
		raw, err := base64.RawURLEncoding.Strict().DecodeString(*request.Cursor)
		if err != nil {
			return MCPListSelection{}, mcpInvalidCursor()
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		var c mcpListCursor
		if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF {
			return MCPListSelection{}, mcpInvalidCursor()
		}
		canonical, _ := json.Marshal(c)
		expected, _ := json.Marshal(scope)
		actual, _ := json.Marshal(c.Scope)
		id, err := model.CanonicalID(c.Position.ID)
		if !bytes.Equal(raw, canonical) || !bytes.Equal(expected, actual) || err != nil || id != c.Position.ID || c.Position.CreatedAt.IsZero() || c.Position.Group < 0 || c.Position.Group > 4 || !mcpDecimal(c.Fence.Count) || !mcpDecimal(c.Fence.VersionSum) {
			return MCPListSelection{}, mcpInvalidCursor()
		}
		selection.prior = &c
		selection.query.After = &c.Position
	}
	return selection, nil
}

type MCPListReader interface {
	TaskListFence(context.Context, string) (store.TaskListFence, error)
	TaskPriorityList(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error)
}

// ReadMCPList must run within the same authorized repeatable-read snapshot.
func ReadMCPList(ctx context.Context, reader MCPListReader, projectID string, selection MCPListSelection) (MCPListPage, error) {
	if projectID != selection.scope.Project {
		return MCPListPage{}, invalidInput("Project differs from task list selection.")
	}
	fence, err := reader.TaskListFence(ctx, projectID)
	if err != nil {
		return MCPListPage{}, err
	}
	if selection.prior != nil && selection.prior.Fence != fence {
		return MCPListPage{}, &model.Fault{Code: "list_changed", Message: "Tasks changed during this list; restart the list."}
	}
	page, err := reader.TaskPriorityList(ctx, projectID, selection.query)
	if err != nil {
		return MCPListPage{}, err
	}
	return MCPListPage{Items: page.Items, HasMore: page.HasMore, fence: fence}, nil
}

func priority(task model.Task) int {
	if task.Status == model.TaskInProgress {
		return 0
	}
	if task.Ready {
		return 1
	}
	if task.Status == model.TaskTodo {
		return 2
	}
	if task.Status == model.TaskProposed {
		return 3
	}
	return 4
}

// CursorAfter uses the last actually returned item, including after byte-budget truncation.
func (page MCPListPage) CursorAfter(selection MCPListSelection, last model.Task) (string, error) {
	if last.ProjectID != selection.scope.Project || last.CreatedAt.IsZero() {
		return "", fmt.Errorf("invalid task list continuation")
	}
	c := mcpListCursor{Scope: selection.scope, Fence: page.fence, Position: store.TaskPriorityPosition{Group: priority(last), CreatedAt: last.CreatedAt.UTC().Round(0), ID: last.ID}}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
