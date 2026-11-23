package api

import "time"

// BotDeletionRecovery is separate from the stable minimal Bot deletion DTO.
type BotDeletionRecovery struct {
	SchemaVersion     int                  `json:"schemaVersion"`
	BotID             string               `json:"botId"`
	Version           int64                `json:"version,string"`
	DeletionID        string               `json:"deletionId"`
	RequestedVersion  int64                `json:"requestedVersion,string"`
	WorkerID          string               `json:"workerId"`
	HostingWorkerID   string               `json:"hostingWorkerId"`
	RequiresStopProof bool                 `json:"requiresStopProof"`
	RecoveryRequired  bool                 `json:"recoveryRequired"`
	OriginalBinding   *BotDeletionBinding  `json:"originalBinding"`
	WorkerCleanup     BotResult            `json:"workerCleanup"`
	Decision          *BotDeletionDecision `json:"decision"`
	ServerCleanup     BotResult            `json:"serverCleanup"`
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
