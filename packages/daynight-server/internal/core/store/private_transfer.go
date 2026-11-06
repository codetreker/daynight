package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// PrivateTransferWriter runs a short transaction with no initial ledger lock.
// A mutation locks the transfer first, verifies authorization, then takes the
// ledger only if needed. Never acquire a new transfer or authorization lock once
// the ledger is held. A scope is valid only in the callback; do not perform
// content I/O inside it.
type PrivateTransferWriter interface {
	WritePrivateTransfer(context.Context, func(PrivateTransferDAO) error) (Completion, error)
}

// PrivateTransferStats contains aggregate operational facts without transfer identifiers.
type PrivateTransferStats struct {
	ReservedBytes          int64
	CleanupPending         int64
	OldestPendingCreatedAt *time.Time
}

type PrivateTransferDAO interface {
	Stats(context.Context) (PrivateTransferStats, error)
	// Authorize verifies the current credential, stable authority, Task presence,
	// and Project access, rechecking expiry after all potentially blocking locks.
	Authorize(context.Context, model.Principal, string, string, string, string) error
	Get(context.Context, string) (model.PrivateTransfer, error)
	// Create returns an existing record without consuming a second slot; its caller
	// must compare the complete immutable binding before returning any information.
	Create(context.Context, model.PrivateTransfer) (model.PrivateTransfer, bool, error)
	// LockLedger follows the transfer and authorization locks. Sampling disk free
	// space and reading totals must happen while this lock is held.
	LockLedger(context.Context) error
	ReservedTotal(context.Context) (int64, error)
	OutstandingTotal(context.Context) (int64, error)
	Reserve(context.Context, string, int64, int64) (model.PrivateTransfer, error)
	// ConsumeReservation must share the receipt transaction after file publication.
	// It reduces only unmaterialized bytes; all reserved bytes remain charged until cleanup.
	ConsumeReservation(context.Context, string, int64, int64) (model.PrivateTransfer, error)
	// Chunk receipts are accessed only after locking and authorizing the owning
	// transfer. Insert, reservation consumption, and the transfer state update
	// must share one transaction after the private object is published.
	UploadChunk(context.Context, string, string) (model.UploadChunk, error)
	UploadChunkAt(context.Context, string, int64) (model.UploadChunk, error)
	InsertUploadChunk(context.Context, model.UploadChunk) error
	Update(context.Context, model.PrivateTransfer, int64) (model.PrivateTransfer, error)
	// UpdatePending only records late facts for the same operation while cleanup waits.
	UpdatePending(context.Context, model.PrivateTransfer, int64) (model.PrivateTransfer, error)
	// Close must only be invoked after acquiring the namespace gate and successfully
	// deleting its objects; it atomically releases the reservation and slot.
	Close(context.Context, string, int64, time.Time) (model.PrivateTransfer, error)
	Due(context.Context, time.Time, int) ([]model.PrivateTransfer, error)
	Prune(context.Context, time.Time, int) (int64, error)
}
