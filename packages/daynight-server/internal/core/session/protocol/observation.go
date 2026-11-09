package sessionprotocol

import "time"

// TaskSessionObservation is an ephemeral read projection, never a Task property.
type TaskSessionObservation struct {
	SchemaVersion       int             `json:"schemaVersion"`
	Observation         string          `json:"observation"`
	Registration        string          `json:"registration"`
	SessionID           *string         `json:"sessionId"`
	NativeSessionID     *string         `json:"nativeSessionId"`
	ClaimID             *string         `json:"claimId"`
	ExecutionGeneration *string         `json:"executionGeneration"`
	ConnectionEpoch     *string         `json:"connectionEpoch"`
	AgentControlMode    *string         `json:"agentControlMode"`
	ContentKind         *string         `json:"contentKind"`
	Provider            *string         `json:"provider"`
	Indicator           *string         `json:"indicator"`
	Reason              string          `json:"reason"`
	Activity            *string         `json:"activity"`
	ConnectionState     *string         `json:"connectionState"`
	Lifecycle           *string         `json:"lifecycle"`
	CurrentTurnID       *string         `json:"currentTurnId"`
	NeedsAttention      *bool           `json:"needsAttention"`
	Send                TaskSessionSend `json:"send"`
	ObservedAt          *time.Time      `json:"observedAt"`
	LastSeenAt          *time.Time      `json:"lastSeenAt"`
	FreshUntil          *time.Time      `json:"freshUntil"`
	Error               *OperationError `json:"error"`
}

type TaskSessionSend struct {
	Allowed *bool   `json:"allowed"`
	Mode    *string `json:"mode"`
	Reason  string  `json:"reason"`
}

type TaskSessionInspection struct {
	SchemaVersion  int                    `json:"schemaVersion"`
	ProjectID      string                 `json:"projectId"`
	TaskID         string                 `json:"taskId"`
	SessionID      string                 `json:"sessionId"`
	CurrentBinding bool                   `json:"currentBinding"`
	Fence          ControllerFence        `json:"fence"`
	Source         string                 `json:"source"`
	Session        TaskSessionObservation `json:"session"`
}
