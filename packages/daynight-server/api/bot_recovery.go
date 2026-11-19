package api

import "time"

// BotRecoveryReceipt identifies one committed operation without carrying its
// private recovery identity or Controller token.
type BotRecoveryReceipt struct {
	BotRecoveryVersion   int        `json:"botRecoveryVersion"`
	OperationID          string     `json:"operationId"`
	Kind                 string     `json:"kind"`
	WorkerID             string     `json:"workerId"`
	HostingGeneration    int64      `json:"hostingGeneration,string"`
	BotVersion           int64      `json:"botVersion,string"`
	SessionID            string     `json:"sessionId"`
	TestExecutionID      string     `json:"testExecutionId"`
	NativeSessionID      *string    `json:"nativeSessionId"`
	ExecutionGeneration  string     `json:"executionGeneration"`
	ControllerID         string     `json:"controllerId"`
	ControllerInstanceID string     `json:"controllerInstanceId"`
	GrantExpiresAt       *time.Time `json:"grantExpiresAt"`
	ControllerTokenHash  *string    `json:"controllerTokenHash"`
}

type BotRecoveryResult struct {
	Receipt BotRecoveryReceipt `json:"receipt"`
	Current bool               `json:"current"`
}
