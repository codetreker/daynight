package query

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type listCursor struct {
	Version            int                 `json:"version"`
	Kind               string              `json:"kind"`
	UserID             string              `json:"userId,omitempty"`
	ProjectID          string              `json:"projectId"`
	TeamID             string              `json:"teamId,omitempty"`
	Status             *string             `json:"status"`
	Ready              *bool               `json:"ready"`
	AllowAgents        *bool               `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform `json:"compatiblePlatform"`
	PlatformSpecific   *bool               `json:"platformSpecific,omitempty"`
	WorkerID           *string             `json:"workerId"`
	WorkerUserID       *string             `json:"workerUserId"`
	AssignedTo         json.RawMessage     `json:"assignedTo,omitempty"`
	CreatedAt          time.Time           `json:"createdAt"`
	ID                 string              `json:"id"`
}

type ListScope struct {
	Kind               string
	UserID             string
	ProjectID          string
	TeamID             string
	Status             *string
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	PlatformSpecific   *bool
	WorkerID           *string
	WorkerUserID       *string
	AssignedTo         model.TaskAssignmentFilter
}

func ListPage(request model.PageRequest, scope ListScope) (store.Page, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return store.Page{}, invalidInput("Limit must be between 1 and 100.")
	}
	page := store.Page{Limit: request.Limit}
	if request.Cursor == nil {
		return page, nil
	}
	if len(*request.Cursor) > transport.MaxEncodedCursorBytes {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(*request.Cursor)
	if err != nil {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var cursor listCursor
	if err := decoder.Decode(&cursor); err != nil {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	expectedVersion := 1
	if scope.Kind == "tasks" {
		expectedVersion = 2
		expectedAssignment, err := TaskAssignmentScope(scope.AssignedTo)
		if err != nil {
			return store.Page{}, err
		}
		var assignment string
		if len(cursor.AssignedTo) == 0 || json.Unmarshal(cursor.AssignedTo, &assignment) != nil || assignment != expectedAssignment {
			return store.Page{}, invalidInput("Cursor is invalid for this list.")
		}
	} else if cursor.AssignedTo != nil {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	id, err := model.CanonicalID(cursor.ID)
	if err != nil || id != cursor.ID || cursor.Version != expectedVersion || cursor.Kind != scope.Kind ||
		cursor.UserID != scope.UserID || cursor.ProjectID != scope.ProjectID || cursor.TeamID != scope.TeamID || !model.EqualOptional(cursor.Status, scope.Status) ||
		!model.EqualOptional(cursor.Ready, scope.Ready) || !model.EqualOptional(cursor.AllowAgents, scope.AllowAgents) || !model.EqualOptional(cursor.CompatiblePlatform, scope.CompatiblePlatform) || !model.EqualOptional(cursor.PlatformSpecific, scope.PlatformSpecific) || !model.EqualOptional(cursor.WorkerID, scope.WorkerID) || !model.EqualOptional(cursor.WorkerUserID, scope.WorkerUserID) || cursor.CreatedAt.IsZero() {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	page.After = &store.Position{CreatedAt: cursor.CreatedAt, ID: id}
	return page, nil
}

func EncodeListCursor(scope ListScope, createdAt time.Time, id string) (string, error) {
	cursor := listCursor{Version: 1, Kind: scope.Kind, UserID: scope.UserID, ProjectID: scope.ProjectID, TeamID: scope.TeamID, Status: scope.Status,
		Ready: scope.Ready, AllowAgents: scope.AllowAgents, CompatiblePlatform: scope.CompatiblePlatform, PlatformSpecific: scope.PlatformSpecific, WorkerID: scope.WorkerID, WorkerUserID: scope.WorkerUserID, CreatedAt: createdAt, ID: id}
	if scope.Kind == "tasks" {
		assignment, err := TaskAssignmentScope(scope.AssignedTo)
		if err != nil {
			return "", err
		}
		cursor.Version = 2
		cursor.AssignedTo, err = json.Marshal(assignment)
		if err != nil {
			return "", err
		}
	}
	data, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
