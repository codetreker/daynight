package core

import "time"

// Bot is an owner-scoped definition independent of projects and task claims.
// Session and role values remain unset until an authorized registration binds them.
type Bot struct {
	ID                    string
	OwnerUserID           string
	WorkerID              string
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
	WorkerID *string `json:"workerId,omitempty"`
	Cwd      *string `json:"cwd,omitempty"`
	Provider *string `json:"provider,omitempty"`
}

// BotConfiguration freezes the settings resolved for the original creation.
type BotConfiguration struct {
	WorkerID string   `json:"workerId"`
	Cwd      string   `json:"cwd"`
	Provider string   `json:"provider"`
	Model    *string  `json:"model"`
	Args     []string `json:"args"`
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
	DeletionID       string           `json:"deletionId"`
	RequestedVersion int64            `json:"requestedVersion,string"`
	WorkerCleanup    BotCleanupResult `json:"workerCleanup"`
	ServerCleanup    BotCleanupResult `json:"serverCleanup"`
}
