package model

import (
	"encoding/json"
	"time"
)

// Bot is an owner-scoped definition independent of projects and task claims.
// Session and role values remain unset until an authorized registration binds them.
type Bot struct {
	AttentionCount        int64
	ID                    string
	OwnerUserID           string
	WorkerID              string // Original creation selection; Recovery owns later hosting.
	Recovery              *BotRecovery
	Name                  string
	Version               int64
	CreationOrder         int64
	RequestFingerprint    string
	RequestedOverrides    BotOverrides
	ResolvedConfiguration BotConfiguration
	RoleConfiguration     *BotRoleConfiguration
	SessionID             *string
	TestExecutionID       *string
	StartupResult         BotStartupResult
	Deletion              *BotDeletion
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// BotOverrides preserves which settings the caller explicitly supplied.
type BotOverrides struct {
	WorkerID        *string `json:"workerId,omitempty"`
	Cwd             *string `json:"cwd,omitempty"`
	Provider        *string `json:"provider,omitempty"`
	Model           *string `json:"model,omitempty"`
	ReasoningEffort *string `json:"reasoningEffort,omitempty"`
}

// BotConfiguration freezes the settings resolved for the original creation.
type BotConfiguration struct {
	WorkerID        string        `json:"workerId"`
	Cwd             string        `json:"cwd"`
	Provider        string        `json:"provider"`
	Model           *string       `json:"model"`
	Args            []string      `json:"args"`
	ReasoningEffort *string       `json:"reasoningEffort,omitempty"`
	Selection       *BotSelection `json:"selection,omitempty"`
}

type BotRoleConfiguration struct {
	Instructions string `json:"instructions"`
	Revision     string `json:"revision"`
	Digest       string `json:"digest"`
}

type BotStartupResult struct {
	State string  `json:"state"`
	Code  *string `json:"code"`
}

type BotCleanupResult struct {
	State string  `json:"state"`
	Code  *string `json:"code"`
}

// BotDeletion records the original deletion request and both cleanup obligations.
// A pending intent is not evidence that a process stopped or history was removed.
type BotDeletion struct {
	// Recovery is an owner decision, never a Worker stop receipt. Public Bot
	// projections omit it; the deletion-recovery resource owns its representation.
	Recovery *BotDeletionRecovery `json:"recovery,omitempty"`
	// ReceiptDigest preserves exact completed Worker replay after Session removal.
	ReceiptDigest    string           `json:"receiptDigest,omitempty"`
	DeletionID       string           `json:"deletionId"`
	RequestedVersion int64            `json:"requestedVersion,string"`
	WorkerCleanup    BotCleanupResult `json:"workerCleanup"`
	ServerCleanup    BotCleanupResult `json:"serverCleanup"`
}

type BotDeletionBinding struct {
	SessionID            string `json:"sessionId"`
	TestExecutionID      string `json:"testExecutionId"`
	ExecutionGeneration  string `json:"executionGeneration"`
	ControllerID         string `json:"controllerId"`
	ControllerInstanceID string `json:"controllerInstanceId"`
}

type BotDeletionDecision struct {
	OperationID      string    `json:"operationId"`
	RequestedVersion int64     `json:"requestedVersion,string"`
	ActorUserID      string    `json:"actorUserId"`
	Reason           string    `json:"reason"`
	AcknowledgedAt   time.Time `json:"acknowledgedAt"`
	LocalDisposition string    `json:"localDisposition"`
}

// The original binding survives removal of the Session and private definition.
type BotDeletionRecovery struct {
	WorkerID        string              `json:"workerId"`
	OriginalBinding *BotDeletionBinding `json:"originalBinding"`
	Decision        BotDeletionDecision `json:"decision"`
}

// BotSelection records the authority and discovery snapshot of a frozen selection.
type BotSelection struct {
	SchemaVersion           int    `json:"schemaVersion"`
	ModelSource             string `json:"modelSource"`
	ReasoningEffortSource   string `json:"reasoningEffortSource"`
	ConfigurationGeneration string `json:"configurationGeneration,omitempty"`
	CatalogGeneration       string `json:"catalogGeneration,omitempty"`
}

// MarshalJSON retains the old wire shape while making native effort explicit in v1 snapshots.
func (c BotConfiguration) MarshalJSON() ([]byte, error) {
	type plain BotConfiguration
	if c.Selection == nil {
		return json.Marshal(plain(c))
	}
	return json.Marshal(struct {
		plain
		ReasoningEffort *string `json:"reasoningEffort"`
	}{plain(c), c.ReasoningEffort})
}
