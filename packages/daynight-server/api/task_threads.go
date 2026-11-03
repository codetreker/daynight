package api

type CreateThreadMessageRequest struct {
	Body    string  `json:"body"`
	ReplyTo *string `json:"replyTo,omitempty"`
	ClaimID *string `json:"claimId,omitempty"`
}

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
