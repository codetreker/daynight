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

type projectCursor struct {
	Version   int                    `json:"version"`
	Kind      string                 `json:"kind"`
	UserID    string                 `json:"userId"`
	Scope     store.ProjectScopeKind `json:"scope"`
	TeamID    string                 `json:"teamId"`
	CreatedAt time.Time              `json:"createdAt"`
	ID        string                 `json:"id"`
}

func projectListPage(request PageRequest, userID string, scope store.ProjectScope) (store.Page, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return store.Page{}, invalidInput("Limit must be between 1 and 100.")
	}
	page := store.Page{Limit: request.Limit}
	if request.Cursor == nil {
		return page, nil
	}
	invalid := func() (store.Page, error) { return store.Page{}, invalidInput("Cursor is invalid for this list.") }
	data, err := base64.RawURLEncoding.Strict().DecodeString(*request.Cursor)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var cursor projectCursor
	if decoder.Decode(&cursor) != nil || decoder.Decode(new(any)) != io.EOF {
		return invalid()
	}
	id, err := CanonicalID(cursor.ID)
	if err != nil || id != cursor.ID || cursor.Version != 2 || cursor.Kind != "scoped-projects" ||
		cursor.UserID != userID || cursor.Scope != scope.Kind || cursor.TeamID != scope.TeamID || cursor.CreatedAt.IsZero() {
		return invalid()
	}
	page.After = &store.Position{CreatedAt: cursor.CreatedAt, ID: id}
	return page, nil
}

func encodeProjectCursor(project core.Project, userID string, scope store.ProjectScope) (string, error) {
	data, err := json.Marshal(projectCursor{Version: 2, Kind: "scoped-projects", UserID: userID, Scope: scope.Kind, TeamID: scope.TeamID, CreatedAt: project.CreatedAt, ID: project.ID})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
