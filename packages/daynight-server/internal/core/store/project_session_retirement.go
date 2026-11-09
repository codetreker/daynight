package store

import (
	"context"
	"encoding/json"
)

// ProjectSessionRetirementDAO is bound to the deletion transaction after its
// Project and Task locks. A batch closes its rows before it is returned.
type ProjectSessionRetirementDAO interface {
	LockProjectSessions(context.Context, string, string, int) ([]ProjectSessionRetirementFact, error)
	ApplyProjectSessionRetirement(context.Context, []ProjectSessionRetirementPlan) error
}

type ProjectSessionRetirementFact struct {
	ID, Backend, Lifecycle, ControlEpoch string
	Control                              json.RawMessage
}

type ProjectSessionRetirementPlan struct {
	ID             string                            `json:"id"`
	Backend        string                            `json:"backend"`
	SnapshotPatch  map[string]any                    `json:"snapshotPatch,omitempty"`
	SnapshotRemove []string                          `json:"snapshotRemove,omitempty"`
	TerminalPatch  map[string]any                    `json:"terminalPatch,omitempty"`
	Receipts       []ProjectSessionReceiptTransition `json:"receipts"`
}

// ProjectSessionReceiptTransition describes a durable receipt change; a nil
// error code preserves the Web receipt shape without transient error text.
type ProjectSessionReceiptTransition struct {
	Previous  string  `json:"previous"`
	Next      string  `json:"next"`
	ErrorCode *string `json:"errorCode"`
}
