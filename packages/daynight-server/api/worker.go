package api

import "time"

type WorkerMachine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorkerHerdr struct {
	Session     string `json:"session"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
}

type WorkerClaim struct {
	ClaimID         string        `json:"claimId"`
	State           string        `json:"state"`
	UserID          string        `json:"userId"`
	WorkerID        string        `json:"workerId"`
	Machine         WorkerMachine `json:"machine"`
	Platform        string        `json:"platform"`
	Agent           string        `json:"agent"`
	WorktreeID      string        `json:"worktreeId"`
	Phase           string        `json:"phase"`
	Herdr           *WorkerHerdr  `json:"herdr"`
	NativeSessionID *string       `json:"nativeSessionId"`
	ClaimedAt       time.Time     `json:"claimedAt"`
}
