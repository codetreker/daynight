package model

import (
	"encoding/json"
	"time"
)

type WorkerNativeConfiguration struct {
	Agent WorkerAgent `json:"agent"`
	Model *string     `json:"model"`
	Args  []string    `json:"args"`
}

type WorkerProjectConfiguration struct {
	ProjectID       string                     `json:"projectId"`
	NativeOverrides map[string]json.RawMessage `json:"nativeOverrides"`
}

type WorkerConfiguration struct {
	PreferPlatformSpecificTasks bool                         `json:"preferPlatformSpecificTasks"`
	MaxConcurrent               int64                        `json:"maxConcurrent"`
	PollIntervalMs              int64                        `json:"pollIntervalMs"`
	RecoveryLimit               int64                        `json:"recoveryLimit"`
	Native                      WorkerNativeConfiguration    `json:"native"`
	Projects                    []WorkerProjectConfiguration `json:"projects"`
}

type WorkerDesiredConfiguration struct {
	Revision  string              `json:"revision"`
	UpdatedAt time.Time           `json:"updatedAt"`
	Value     WorkerConfiguration `json:"value"`
}

type WorkerConfigurationItemKey struct {
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId,omitempty"`
}

type WorkerConfigurationFailure struct {
	Code       string    `json:"code"`
	Category   string    `json:"category"`
	Phase      string    `json:"phase"`
	OccurredAt time.Time `json:"occurredAt"`
}

type WorkerConfigurationItem struct {
	Key            WorkerConfigurationItemKey  `json:"key"`
	TargetRevision string                      `json:"targetRevision"`
	AppliedValue   json.RawMessage             `json:"appliedValue"`
	State          string                      `json:"state"`
	Error          *WorkerConfigurationFailure `json:"error"`
	LastFailure    *WorkerConfigurationFailure `json:"lastFailure"`
	NextAttemptAt  *time.Time                  `json:"nextAttemptAt"`
}

type WorkerConfigurationObservation struct {
	BaseRevision    string                    `json:"baseRevision"`
	DesiredRevision string                    `json:"desiredRevision"`
	Items           []WorkerConfigurationItem `json:"items"`
}

type WorkerConfigurationReportedObservation struct {
	WorkerConfigurationObservation
	ReportedAt time.Time `json:"reportedAt"`
}

type WorkerConfigurationExchange struct {
	Bootstrap   *WorkerConfiguration            `json:"bootstrap"`
	Observation *WorkerConfigurationObservation `json:"observation"`
}

type WorkerConfigurationResource struct {
	Desired             *WorkerDesiredConfiguration             `json:"desired"`
	ObservationRevision string                                  `json:"observationRevision"`
	Observation         *WorkerConfigurationReportedObservation `json:"observation"`
}

type WorkerConfigurationReceipt struct {
	Desired             *WorkerDesiredConfiguration `json:"desired"`
	ObservationRevision string                      `json:"observationRevision"`
	ObservationAccepted bool                        `json:"observationAccepted"`
}
