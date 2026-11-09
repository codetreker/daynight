package codec

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type ThreadExecution struct {
	ClaimID  string `json:"claimId"`
	WorkerID string `json:"workerId"`
	Provider string `json:"provider"`
}

type ThreadAuthor struct {
	UserID      string           `json:"userId"`
	DisplayName *string          `json:"displayName"`
	Agent       bool             `json:"Agent"`
	Execution   *ThreadExecution `json:"execution,omitempty"`
}

type ThreadMessage struct {
	ID        string       `json:"id"`
	Author    ThreadAuthor `json:"author"`
	Body      string       `json:"body"`
	CreatedAt string       `json:"createdAt"`
	ReplyTo   *string      `json:"replyTo,omitempty"`
}

type ThreadPage struct {
	Items         []ThreadMessage `json:"items"`
	HasMoreBefore bool            `json:"hasMoreBefore"`
	HasMoreAfter  bool            `json:"hasMoreAfter"`
}

const MessageLimit = 64 * 1024

func messageDTO(message model.ThreadMessage, details bool) ThreadMessage {
	result := ThreadMessage{
		ID: message.ID,
		Author: ThreadAuthor{
			UserID: message.Author.UserID, DisplayName: message.Author.DisplayName,
			Agent: message.Author.Agent,
		},
		Body: message.Body, CreatedAt: message.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		ReplyTo: message.ReplyTo,
	}
	if details && message.Author.Agent && message.Author.Execution != nil {
		execution := message.Author.Execution
		result.Author.Execution = &ThreadExecution{ClaimID: execution.ClaimID, WorkerID: execution.WorkerID, Provider: execution.Provider}
	}
	return result
}

func EncodeMessage(message model.ThreadMessage, details bool) ([]byte, error) {
	return json.Marshal(messageDTO(message, details))
}

func EncodePage(page model.ThreadPage, details bool) ([]byte, error) {
	result := ThreadPage{Items: make([]ThreadMessage, 0, len(page.Items)), HasMoreBefore: page.HasMoreBefore, HasMoreAfter: page.HasMoreAfter}
	for _, message := range page.Items {
		result.Items = append(result.Items, messageDTO(message, details))
	}
	return json.Marshal(result)
}
