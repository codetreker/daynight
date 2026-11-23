package api

import "time"

// BotObservation is the versioned read-only availability and location resource.
// Its state never confers Session input authority.
type BotObservation struct {
	SchemaVersion       int            `json:"schemaVersion"`
	BotID               string         `json:"botId"`
	BotVersion          int64          `json:"botVersion,string"`
	WorkerID            string         `json:"workerId"`
	Machine             *WorkerMachine `json:"machine"`
	Provider            string         `json:"provider"`
	SessionID           *string        `json:"sessionId"`
	TestExecutionID     *string        `json:"testExecutionId"`
	NativeSessionID     *string        `json:"nativeSessionId"`
	HostingGeneration   *string        `json:"hostingGeneration"`
	ExecutionGeneration *string        `json:"executionGeneration"`
	ConnectionEpoch     *string        `json:"connectionEpoch"`
	State               string         `json:"state"`
	Reason              string         `json:"reason"`
	ObservedAt          time.Time      `json:"observedAt"`
	WorkerLastSeenAt    *time.Time     `json:"workerLastSeenAt"`
	SessionLastSeenAt   *time.Time     `json:"sessionLastSeenAt"`
	FreshUntil          *time.Time     `json:"freshUntil"`
	CurrentTurnID       *string        `json:"currentTurnId"`
}
