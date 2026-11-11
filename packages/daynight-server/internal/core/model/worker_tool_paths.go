package model

import "time"

type ToolPathChoice struct {
	Kind string `json:"kind"`
	Path string `json:"path,omitempty"`
}

// Nil choices have not been adopted. Auto is an explicit cloud choice.
type WorkerToolPaths struct {
	Codex   *ToolPathChoice `json:"codex"`
	Copilot *ToolPathChoice `json:"copilot"`
	Herdr   *ToolPathChoice `json:"herdr"`
}

type ToolPathTelemetry struct {
	SchemaVersion int                   `json:"schemaVersion"`
	ObservedAt    time.Time             `json:"observedAt"`
	Entries       []ToolPathObservation `json:"entries"`
}

type ToolPathObservation struct {
	Tool                     string                    `json:"tool"`
	Context                  string                    `json:"context"`
	ConfigurationSource      string                    `json:"configurationSource"`
	TargetRevision           *string                   `json:"targetRevision"`
	Target                   ToolPathChoice            `json:"target"`
	State                    string                    `json:"state"`
	Reason                   *string                   `json:"reason"`
	Actual                   *ToolPathActual           `json:"actual"`
	Candidate                *ToolPathActual           `json:"candidate"`
	ActiveSelectionCount     *int64                    `json:"activeSelectionCount"`
	ActiveSelectionsComplete bool                      `json:"activeSelectionsComplete"`
	ActiveObservationError   *string                   `json:"activeObservationError"`
	ActiveSelections         []ToolPathActiveSelection `json:"activeSelections"`
	Error                    *ToolPathError            `json:"error"`
}

type ToolPathActual struct {
	Selection       ToolPathChoice `json:"selection"`
	SelectionKey    string         `json:"selectionKey"`
	EntryPath       string         `json:"entryPath"`
	ExecutablePath  string         `json:"executablePath"`
	InterpreterPath *string        `json:"interpreterPath"`
	Source          string         `json:"source"`
	Version         string         `json:"version"`
	CheckedAt       time.Time      `json:"checkedAt"`
}

type ToolPathActiveSelection struct {
	Actual           ToolPathActual `json:"actual"`
	ExecutionCount   *int64         `json:"executionCount"`
	InstanceCount    *int64         `json:"instanceCount"`
	UnconfirmedCount int64          `json:"unconfirmedCount"`
}

type ToolPathError struct {
	Code       string    `json:"code"`
	OccurredAt time.Time `json:"occurredAt"`
}
