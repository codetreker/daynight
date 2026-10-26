package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type listCursor struct {
	Version            int                `json:"version"`
	Kind               string             `json:"kind"`
	ProjectID          string             `json:"projectId"`
	Status             *string            `json:"status"`
	Ready              *bool              `json:"ready"`
	AllowAgents        *bool              `json:"allowAgents"`
	CompatiblePlatform *core.TaskPlatform `json:"compatiblePlatform"`
	WorkerID           *string            `json:"workerId"`
	WorkerUserID       *string            `json:"workerUserId"`
	CreatedAt          time.Time          `json:"createdAt"`
	ID                 string             `json:"id"`
}

type listScope struct {
	Kind               string
	ProjectID          string
	Status             *string
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *core.TaskPlatform
	WorkerID           *string
	WorkerUserID       *string
}

func projectListPage(request PageRequest) (store.Page, error) {
	return listPage(request, listScope{Kind: "projects"})
}

func listPage(request PageRequest, scope listScope) (store.Page, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return store.Page{}, invalidInput("Limit must be between 1 and 100.")
	}
	page := store.Page{Limit: request.Limit}
	if request.Cursor == nil {
		return page, nil
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
	id, err := CanonicalID(cursor.ID)
	if err != nil || id != cursor.ID || cursor.Version != 1 || cursor.Kind != scope.Kind ||
		cursor.ProjectID != scope.ProjectID || !equalOptional(cursor.Status, scope.Status) ||
		!equalOptional(cursor.Ready, scope.Ready) || !equalOptional(cursor.AllowAgents, scope.AllowAgents) || !equalOptional(cursor.CompatiblePlatform, scope.CompatiblePlatform) || !equalOptional(cursor.WorkerID, scope.WorkerID) || !equalOptional(cursor.WorkerUserID, scope.WorkerUserID) || cursor.CreatedAt.IsZero() {
		return store.Page{}, invalidInput("Cursor is invalid for this list.")
	}
	page.After = &store.Position{CreatedAt: cursor.CreatedAt, ID: id}
	return page, nil
}

func encodeProjectCursor(project core.Project) (string, error) {
	return encodeListCursor(listScope{Kind: "projects"}, project.CreatedAt, project.ID)
}

func encodeListCursor(scope listScope, createdAt time.Time, id string) (string, error) {
	cursor := listCursor{Version: 1, Kind: scope.Kind, ProjectID: scope.ProjectID, Status: scope.Status,
		Ready: scope.Ready, AllowAgents: scope.AllowAgents, CompatiblePlatform: scope.CompatiblePlatform, WorkerID: scope.WorkerID, WorkerUserID: scope.WorkerUserID, CreatedAt: createdAt, ID: id}
	data, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func equalOptional[T comparable](left, right *T) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}
