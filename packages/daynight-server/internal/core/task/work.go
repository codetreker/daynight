package task

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type WorkRequest struct {
	ResponseOverhead int // Transport-owned encoded envelope bytes, never user input.
	AssignedTo       *string
	Limit            int
	Cursor           *string
	GroupID          *string
	TargetsCursor    *string
}
type workScope struct {
	Version    int    `json:"version"`
	Actor      string `json:"actor"`
	Project    string `json:"project"`
	AssignedTo string `json:"assignedTo"`
}
type workCursor struct {
	Scope  workScope                     `json:"scope"`
	Fence  store.TaskSearchFence         `json:"fence"`
	Group  *store.TaskWorkPosition       `json:"group"`
	Target *store.TaskWorkTargetPosition `json:"target"`
}
type WorkSelection struct {
	Query       store.TaskWorkQuery
	AfterTarget *store.TaskWorkTargetPosition
	scope       workScope
	prior       *workCursor
}

func SelectWork(projectID, actorID string, request WorkRequest) (WorkSelection, error) {
	project, err := model.CanonicalID(projectID)
	if err != nil {
		return WorkSelection{}, err
	}
	actor, err := model.CanonicalID(actorID)
	if err != nil {
		return WorkSelection{}, err
	}
	assigned := actor
	if request.AssignedTo != nil && *request.AssignedTo != "me" {
		assigned, err = model.CanonicalID(*request.AssignedTo)
		if err != nil {
			return WorkSelection{}, invalidInput("Work overview requires an assigned user or me.")
		}
	}
	if request.Limit == 0 {
		request.Limit = 20
	}
	if request.Limit < 1 || request.Limit > 50 {
		return WorkSelection{}, invalidInput("Work limit must be between 1 and 50.")
	}
	if (request.GroupID == nil) != (request.TargetsCursor == nil) || request.Cursor != nil && request.GroupID != nil {
		return WorkSelection{}, invalidInput("groupId and targetsCursor must be paired and cannot be combined with cursor.")
	}
	selection := WorkSelection{scope: workScope{Version: 1, Actor: actor, Project: project, AssignedTo: assigned}, Query: store.TaskWorkQuery{AssignedTo: assigned, Limit: request.Limit}}
	token := request.Cursor
	if request.GroupID != nil {
		id, err := model.CanonicalID(*request.GroupID)
		if err != nil {
			return WorkSelection{}, err
		}
		selection.Query.GroupID = &id
		token = request.TargetsCursor
	}
	if token == nil {
		return selection, nil
	}
	invalid := func() (WorkSelection, error) {
		return WorkSelection{}, invalidInput("Cursor is invalid for this work overview.")
	}
	if len(*token) > transport.MaxEncodedCursorBytes {
		return invalid()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(*token)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var c workCursor
	if decoder.Decode(&c) != nil || decoder.Decode(new(any)) != io.EOF {
		return invalid()
	}
	canonical, _ := json.Marshal(c)
	if !bytes.Equal(raw, canonical) || c.Scope != selection.scope || !mcpDecimal(c.Fence.Count) || !mcpDecimal(c.Fence.VersionSum) {
		return invalid()
	}
	if id, err := model.CanonicalID(c.Fence.Epoch); err != nil || id != c.Fence.Epoch {
		return invalid()
	}
	if request.GroupID == nil {
		if c.Target != nil || c.Group == nil || c.Group.StartedAt.IsZero() {
			return invalid()
		}
		if id, err := model.CanonicalID(c.Group.GroupID); err != nil || id != c.Group.GroupID {
			return invalid()
		}
		selection.Query.After = c.Group
	} else {
		if c.Group != nil || c.Target == nil || c.Target.GroupID != *selection.Query.GroupID {
			return invalid()
		}
		if id, err := model.CanonicalID(c.Target.TaskID); err != nil || id != c.Target.TaskID {
			return invalid()
		}
		selection.AfterTarget = c.Target
	}
	selection.prior = &c
	return selection, nil
}
func (selection WorkSelection) CheckFence(fence store.TaskSearchFence) error {
	if selection.prior != nil && selection.prior.Fence != fence {
		return &model.Fault{Code: "reset_required", Message: "Tasks changed during this work overview; restart the overview."}
	}
	return nil
}
func (selection WorkSelection) CursorAfter(fence store.TaskSearchFence, position store.TaskWorkPosition) (string, error) {
	return encodeWorkCursor(workCursor{Scope: selection.scope, Fence: fence, Group: &position})
}
func (selection WorkSelection) TargetCursor(fence store.TaskSearchFence, position store.TaskWorkTargetPosition) (string, error) {
	return encodeWorkCursor(workCursor{Scope: selection.scope, Fence: fence, Target: &position})
}
func encodeWorkCursor(c workCursor) (string, error) {
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
