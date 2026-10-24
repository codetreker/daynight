package core

import "time"

type WorkerState string

const (
	WorkerActive    WorkerState = "active"
	WorkerReleased  WorkerState = "released"
	WorkerCompleted WorkerState = "completed"
)

func (state WorkerState) Valid() bool {
	return state == WorkerActive || state == WorkerReleased || state == WorkerCompleted
}

type WorkerAgent string

const (
	AgentCodex   WorkerAgent = "codex"
	AgentCopilot WorkerAgent = "copilot"
)

func (agent WorkerAgent) Valid() bool { return agent == AgentCodex || agent == AgentCopilot }

type WorkerPhase string

const (
	WorkerPreparing  WorkerPhase = "preparing"
	WorkerExecuting  WorkerPhase = "executing"
	WorkerVerifying  WorkerPhase = "verifying"
	WorkerCompleting WorkerPhase = "completing"
	WorkerWaiting    WorkerPhase = "waiting"
	WorkerPaused     WorkerPhase = "paused"
)

func (phase WorkerPhase) Valid() bool {
	return phase == WorkerPreparing || phase == WorkerExecuting || phase == WorkerVerifying || phase == WorkerCompleting || phase == WorkerWaiting || phase == WorkerPaused
}

type WorkerMachine struct {
	ID   string
	Name string
}

type WorkerHerdr struct {
	Session     string
	WorkspaceID string
	PaneID      string
}

type WorkerClaim struct {
	ClaimID         string
	State           WorkerState
	UserID          string
	WorkerID        string
	Machine         WorkerMachine
	Platform        TaskPlatform
	Agent           WorkerAgent
	WorktreeID      string
	Phase           WorkerPhase
	Herdr           *WorkerHerdr
	NativeSessionID *string
	ClaimedAt       time.Time
}
