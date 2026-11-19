package store

import (
	"context"
	"encoding/json"
)

// WorkerProjectSelectionDAO participates in the enclosing project transaction.
// Candidates are selected in a single statement snapshot and returned in lock order.
type WorkerProjectSelectionDAO interface {
	ProjectSelectionCandidates(context.Context, string) ([]WorkerSelectionID, error)
	LockProjectSelection(context.Context, WorkerSelectionID) (*WorkerSelectionTarget, error)
	SaveProjectSelection(context.Context, WorkerSelectionID, int64, json.RawMessage) error
}

type WorkerSelectionID struct {
	UserID   string
	WorkerID string
}

type WorkerSelectionTarget struct {
	Revision int64
	Raw      json.RawMessage
}
