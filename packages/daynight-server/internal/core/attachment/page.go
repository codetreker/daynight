package attachment

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type cursor struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Path      string `json:"path"`
}

type Page struct {
	Items      []model.Attachment
	NextCursor *string
}

func invalidInput(message string) *model.Fault {
	return &model.Fault{Code: "invalid_input", Message: message}
}

func ListQuery(request model.PageRequest, projectID, taskID string) (store.AttachmentQuery, error) {
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
	var value cursor
	if err := decoder.Decode(&value); err != nil {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	if value.Version != 1 || value.Kind != "attachments" || value.ProjectID != projectID || value.TaskID != taskID ||
		filestorage.ValidateAddress(Bucket, value.Path) != nil {
		return store.AttachmentQuery{}, invalidInput("Cursor is invalid for this list.")
	}
	query.After = &value.Path
	return query, nil
}

func MakePage(result store.AttachmentPage, projectID, taskID string) (Page, error) {
	response := Page{Items: result.Items}
	if result.HasMore {
		data, err := json.Marshal(cursor{Version: 1, Kind: "attachments", ProjectID: projectID,
			TaskID: taskID, Path: result.Items[len(result.Items)-1].Path})
		if err != nil {
			return Page{}, err
		}
		encoded := base64.RawURLEncoding.EncodeToString(data)
		response.NextCursor = &encoded
	}
	return response, nil
}
