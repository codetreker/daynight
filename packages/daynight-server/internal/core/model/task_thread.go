package model

import "time"

// ThreadPosition is an internal, task-local position. Public cursors use only ID.
type ThreadPosition struct {
	CreatedAt time.Time
	ID        string
}

type ThreadExecution struct {
	ClaimID  string
	WorkerID string
	Provider string
}

// ThreadAuthor is immutable historical attribution, including a nullable name.
type ThreadAuthor struct {
	UserID      string
	DisplayName *string
	Agent       bool
	Execution   *ThreadExecution
}

type ThreadMessage struct {
	TaskID    string
	ID        string
	Author    ThreadAuthor
	Body      string
	CreatedAt time.Time
	ReplyTo   *string
}

func (message ThreadMessage) Position() ThreadPosition {
	return ThreadPosition{CreatedAt: message.CreatedAt, ID: message.ID}
}

type ThreadPage struct {
	Items         []ThreadMessage
	HasMoreBefore bool
	HasMoreAfter  bool
}
