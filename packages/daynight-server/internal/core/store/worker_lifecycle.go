package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// WorkerLifecycleStore keeps lifecycle changes and their original receipts in
// one transaction. Completion, rather than a callback result, proves commit.
type WorkerLifecycleStore interface {
	WriteWorkerLifecycle(context.Context, func(WorkerLifecycleScope) error) (Completion, error)
	ReadWorkerLifecycle(context.Context, func(WorkerLifecycleSnapshot) error) error
}

type WorkerLifecycleReader interface {
	Lifecycle(context.Context, string, string) (model.WorkerLifecycle, error)
	Operation(context.Context, string, string, string) (model.LifecycleOperation, error)
	Observation(context.Context, string, string) (model.LifecycleStoredObservation, error)
}

type WorkerLifecycleDAO interface {
	WorkerLifecycleReader
	// LockWorker locks the existing owner/Worker row until transaction completion.
	// It returns ErrNotFound for an absent Worker and never creates that Worker.
	LockWorker(context.Context, string, string) error
	SaveLifecycle(context.Context, model.WorkerLifecycle) error
	SaveOperation(context.Context, model.LifecycleOperation) error
	SaveObservation(context.Context, model.LifecycleStoredObservation) error
	DeleteObservation(context.Context, string, string) error
}

// WorkerLifecycleScope retains the existing Worker credential admission lock.
type WorkerLifecycleScope interface {
	WorkerScope
	LifecycleDAO() WorkerLifecycleDAO
}

type WorkerLifecycleSnapshot interface {
	SnapshotScope
	LifecycleDAO() WorkerLifecycleReader
}
