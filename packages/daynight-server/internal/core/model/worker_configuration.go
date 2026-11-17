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
	ToolPaths                   WorkerToolPaths              `json:"toolPaths"`
	PreserveSudoCleanup         bool                         `json:"-"`
	EnableSudoCleanup           bool                         `json:"enableSudoCleanup"`
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
	Value     WorkerConfiguration `json:"-"`
	RawValue  json.RawMessage     `json:"-"`
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
	ToolPathsBootstrap *WorkerToolPaths                `json:"toolPathsBootstrap,omitempty"`
	Bootstrap          *WorkerConfiguration            `json:"bootstrap"`
	Observation        *WorkerConfigurationObservation `json:"observation"`
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

// MarshalJSON retains the exact stored target, including fields unsupported by
// the current write schema, until a user explicitly replaces it.
func (d WorkerDesiredConfiguration) MarshalJSON() ([]byte, error) {
	value := d.RawValue
	if value == nil {
		var err error
		value, err = json.Marshal(d.Value)
		if err != nil {
			return nil, err
		}
	}
	return json.Marshal(struct {
		Revision  string          `json:"revision"`
		UpdatedAt time.Time       `json:"updatedAt"`
		Value     json.RawMessage `json:"value"`
	}{d.Revision, d.UpdatedAt, value})
}

func (d *WorkerDesiredConfiguration) UnmarshalJSON(data []byte) error {
	var wire struct {
		Revision  string          `json:"revision"`
		UpdatedAt time.Time       `json:"updatedAt"`
		Value     json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	d.Revision, d.UpdatedAt, d.RawValue = wire.Revision, wire.UpdatedAt, append(json.RawMessage(nil), wire.Value...)
	if err := json.Unmarshal(wire.Value, &d.Value); err != nil {
		d.Value = WorkerConfiguration{}
	}
	return nil
}
