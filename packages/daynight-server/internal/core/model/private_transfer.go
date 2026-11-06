package model

import (
	"encoding/json"
	"time"
)

// PrivateTransfer is the durable owner of a private transfer namespace.
// Binding is immutable and contains the remaining direction-specific parameters.
// Data holds direction-specific state and receipts, never credential secrets.
type PrivateTransfer struct {
	ID, UserID, AuthorityKind, AuthorityID          string
	Direction, ProjectID, TaskID, Path, ContentType string
	Binding, Data                                   json.RawMessage
	State                                           string
	ReservedBytes, OutstandingBytes, Version        int64
	CreatedAt, UpdatedAt, ExpiresAt, HardExpiresAt  time.Time
	CleanupFromState                                *string
	LeaseUntil, RetainUntil, LastCleanupAttempt     *time.Time
}
