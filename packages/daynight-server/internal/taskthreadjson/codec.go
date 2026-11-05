// Package taskthreadjson owns the JSON bytes used for Thread admission and HTTP
// responses. Callers write these bytes without another encoder or trailing LF.
package taskthreadjson

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const (
	MessageLimit = 64 * 1024
	PageLimit    = 256 * 1024
)

func messageDTO(message model.ThreadMessage, details bool) api.ThreadMessage {
	result := api.ThreadMessage{
		ID: message.ID,
		Author: api.ThreadAuthor{
			UserID: message.Author.UserID, DisplayName: message.Author.DisplayName,
			Agent: message.Author.Agent,
		},
		Body: message.Body, CreatedAt: message.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		ReplyTo: message.ReplyTo,
	}
	if details && message.Author.Agent && message.Author.Execution != nil {
		execution := message.Author.Execution
		result.Author.Execution = &api.ThreadExecution{ClaimID: execution.ClaimID, WorkerID: execution.WorkerID, Provider: execution.Provider}
	}
	return result
}

func EncodeMessage(message model.ThreadMessage, details bool) ([]byte, error) {
	return json.Marshal(messageDTO(message, details))
}

func EncodePage(page model.ThreadPage, details bool) ([]byte, error) {
	result := api.ThreadPage{Items: make([]api.ThreadMessage, 0, len(page.Items)), HasMoreBefore: page.HasMoreBefore, HasMoreAfter: page.HasMoreAfter}
	for _, message := range page.Items {
		result.Items = append(result.Items, messageDTO(message, details))
	}
	return json.Marshal(result)
}
