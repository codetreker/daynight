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
// content I/O inside it, except for a bounded upload chunk protected by the Task lifecycle lock.
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
	// LockProjectLifecycle acquires the Task after the transfer and checks the live
	// Project in a fresh statement, without reauthorizing an admitted operation.
	LockProjectLifecycle(context.Context, string, string) error
	Get(context.Context, string) (model.PrivateTransfer, error)
	// Insert returns an existing row on conflict; the caller checks its binding.
	Insert(context.Context, model.PrivateTransfer) (model.PrivateTransfer, bool, error)
	CountActive(context.Context, string) (int, error)
	// Transfer and authorization locks precede the ledger. Do not acquire another
	// transfer or authorization lock after the ledger has been acquired.
	LockLedger(context.Context) error
	ReservedTotal(context.Context) (int64, error)
	OutstandingTotal(context.Context) (int64, error)
	AddReservation(context.Context, string, int64) (model.PrivateTransfer, error)
	SubtractOutstanding(context.Context, string, int64) (model.PrivateTransfer, error)
	Put(context.Context, model.PrivateTransfer, int64) (model.PrivateTransfer, error)
	Release(context.Context, model.PrivateTransfer, int64, time.Time, string) (model.PrivateTransfer, error)
	// Chunk receipts are accessed under the owning transfer lock by an admitted
	// operation. Insert, reservation consumption, and the transfer state update
	// must share one transaction after the private object is published.
	UploadChunk(context.Context, string, string) (model.UploadChunk, error)
	UploadChunkAt(context.Context, string, int64) (model.UploadChunk, error)
	InsertUploadChunk(context.Context, model.UploadChunk) error
	Due(context.Context, time.Time, int) ([]model.PrivateTransfer, error)
	Prune(context.Context, time.Time, int) (int64, error)
}
