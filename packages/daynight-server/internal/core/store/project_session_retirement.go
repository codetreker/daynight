package store

import "context"

// ProjectSessionRetirementDAO is bound to the deletion transaction after its
// Project and Task locks. A batch closes its rows before it is returned.
type ProjectSessionRetirementDAO interface {
	LockProjectSessions(context.Context, string, string, int) ([]ProjectSessionRetirementFact, error)
	ApplyProjectSessionRetirement(context.Context, []ProjectSessionRetirementPlan) error
}

type ProjectSessionRetirementFact struct {
	ID, Backend, Lifecycle string
}

type ProjectSessionRetirementPlan struct {
	ID             string                            `json:"id"`
	Backend        string                            `json:"backend"`
	SnapshotPatch  map[string]any                    `json:"snapshotPatch,omitempty"`
	SnapshotRemove []string                          `json:"snapshotRemove,omitempty"`
	Receipts       []ProjectSessionReceiptTransition `json:"receipts"`
}

// ProjectSessionReceiptTransition describes a durable Web receipt change.
type ProjectSessionReceiptTransition struct {
	Previous string `json:"previous"`
	Next     string `json:"next"`
}
