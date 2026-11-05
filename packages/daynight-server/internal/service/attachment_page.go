package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type attachmentCursor struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Path      string `json:"path"`
}

func attachmentListPage(request model.PageRequest, projectID, taskID string) (store.AttachmentQuery, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return store.AttachmentQuery{}, invalidInput("Limit must be between 1 and 100.")
	}
	query := store.AttachmentQuery{Limit: request.Limit}
	if request.Cursor == nil {
		return query, nil
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(*request.Cursor)
	if err != nil {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var cursor attachmentCursor
	if err := decoder.Decode(&cursor); err != nil {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	if cursor.Version != 1 || cursor.Kind != "attachments" || cursor.ProjectID != projectID || cursor.TaskID != taskID ||
		filestorage.ValidateAddress(attachmentBucket, cursor.Path) != nil {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	query.After = &cursor.Path
	return query, nil
}

func (s *Attachments) List(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (AttachmentPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return AttachmentPage{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return AttachmentPage{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return AttachmentPage{}, err
	}
	query, err := attachmentListPage(request, projectID, taskID)
	if err != nil {
		return AttachmentPage{}, err
	}
	var result store.AttachmentPage
	err = s.read(ctx, principal, projectID, taskID, func(reader store.AttachmentReader) error {
		var err error
		result, err = reader.Attachments(ctx, projectID, taskID, query)
		return err
	})
	if err != nil {
		return AttachmentPage{}, err
	}
	response := AttachmentPage{Items: result.Items}
	if result.HasMore {
		data, err := json.Marshal(attachmentCursor{Version: 1, Kind: "attachments", ProjectID: projectID,
			TaskID: taskID, Path: result.Items[len(result.Items)-1].Path})
		if err != nil {
			return AttachmentPage{}, err
		}
		cursor := base64.RawURLEncoding.EncodeToString(data)
		response.NextCursor = &cursor
	}
	return response, nil
}
