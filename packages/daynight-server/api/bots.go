package api

import "time"

// Bot omits the entire definition once only deletion responsibility is visible.
type Bot struct {
	ID       string       `json:"id"`
	WorkerID string       `json:"workerId"`
	Version  int64        `json:"version,string"`
	Deletion *BotDeletion `json:"deletion"`
	*BotDefinition
}

type BotDefinition struct {
	OwnerUserID           string                `json:"ownerUserId"`
	Name                  string                `json:"name"`
	CreationOrder         int64                 `json:"creationOrder,string"`
	RequestedOverrides    BotOverrides          `json:"requestedOverrides"`
	ResolvedConfiguration BotConfiguration      `json:"resolvedConfiguration"`
	RoleConfiguration     *BotRoleConfiguration `json:"roleConfiguration"`
	SessionID             *string               `json:"sessionId"`
	TestExecutionID       *string               `json:"testExecutionId"`
	StartupResult         BotResult             `json:"startupResult"`
	CreatedAt             time.Time             `json:"createdAt"`
	UpdatedAt             time.Time             `json:"updatedAt"`
}

type BotOverrides struct {
	WorkerID *string `json:"workerId,omitempty"`
	Cwd      *string `json:"cwd,omitempty"`
	Provider *string `json:"provider,omitempty"`
}

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

type BotResult struct {
	State string  `json:"state"`
	Code  *string `json:"code"`
}

type BotDeletion struct {
	DeletionID       string    `json:"deletionId"`
	RequestedVersion int64     `json:"requestedVersion,string"`
	WorkerCleanup    BotResult `json:"workerCleanup"`
	ServerCleanup    BotResult `json:"serverCleanup"`
}

type BotPage struct {
	Items      []Bot   `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

// BotDefaults describes current choices without reserving a Worker or starting a Bot.
type BotDefaults struct {
	ObservedAt    time.Time           `json:"observedAt"`
	WorkerID      *string             `json:"workerId"`
	Configuration *BotConfiguration   `json:"configuration"`
	Reason        *string             `json:"reason"`
	Workers       []BotWorkerDefaults `json:"workers"`
}

type BotWorkerDefaults struct {
	WorkerID      string                    `json:"workerId"`
	Machine       WorkerMachine             `json:"machine"`
	Platform      string                    `json:"platform"`
	State         string                    `json:"state"`
	Reason        *string                   `json:"reason"`
	Configuration *BotConfiguration         `json:"configuration"`
	Providers     []WorkerAssistantProvider `json:"providers"`
}
