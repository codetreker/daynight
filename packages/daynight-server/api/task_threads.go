package api

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"

type CreateThreadMessageRequest struct {
	Body    string  `json:"body"`
	ReplyTo *string `json:"replyTo,omitempty"`
	ClaimID *string `json:"claimId,omitempty"`
}

type ThreadExecution = codec.ThreadExecution
type ThreadAuthor = codec.ThreadAuthor
type ThreadMessage = codec.ThreadMessage
type ThreadPage = codec.ThreadPage
