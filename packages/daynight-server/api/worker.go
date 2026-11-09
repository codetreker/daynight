package api

import (
	"time"

	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

type WorkerMachine = workerprotocol.WorkerMachine

type WorkerHerdr struct {
	Session     string `json:"session"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
}

type WorkerClaim struct {
	ClaimID          string        `json:"claimId"`
	State            string        `json:"state"`
	UserID           string        `json:"userId"`
	WorkerID         string        `json:"workerId"`
	Machine          WorkerMachine `json:"machine"`
	Platform         string        `json:"platform"`
	Agent            string        `json:"agent"`
	AgentControlMode string        `json:"agentControlMode,omitempty"`
	WorktreeID       string        `json:"worktreeId"`
	Phase            string        `json:"phase"`
	Herdr            *WorkerHerdr  `json:"herdr"`
	NativeSessionID  *string       `json:"nativeSessionId"`
	ClaimedAt        time.Time     `json:"claimedAt"`
}
