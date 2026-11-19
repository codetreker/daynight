package query

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type GoalPageScope struct {
	ProjectID, GoalID, UserID string
	Limit                     int
}
type goalCursor struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	GoalID    string `json:"goalId"`
	UserID    string `json:"userId"`
	Limit     int    `json:"limit"`
	After     string `json:"after"`
}

func GoalPageAfter(cursor *string, scope GoalPageScope) (string, error) {
	if cursor == nil {
		return "", nil
	}
	invalid := func() (string, error) { return "", invalidInput("Cursor is invalid for this Goal dependency list.") }
	if len(*cursor) > transport.MaxEncodedCursorBytes {
		return invalid()
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(*cursor)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value goalCursor
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return invalid()
	}
	id, err := model.CanonicalID(value.After)
	if err != nil || id != value.After || value.Version != 1 || value.Kind != "goal-successors" || value.ProjectID != scope.ProjectID || value.GoalID != scope.GoalID || value.UserID != scope.UserID || value.Limit != scope.Limit {
		return invalid()
	}
	return id, nil
}
func EncodeGoalCursor(scope GoalPageScope, after string) (string, error) {
	data, err := json.Marshal(goalCursor{Version: 1, Kind: "goal-successors", ProjectID: scope.ProjectID, GoalID: scope.GoalID, UserID: scope.UserID, Limit: scope.Limit, After: after})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
