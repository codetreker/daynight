package store

import "context"

// WorkerExecutionAdmission serializes business authorization with lifecycle
// changes. The caller first holds its Task, Bot and Session locks, as applicable.
// The Worker lock remains held until the caller's transaction completes. Workers
// that have never registered lifecycle support retain their existing admission.
type WorkerExecutionAdmission interface {
	CheckWorkerExecution(context.Context, string, string) error
	// WorkerExecutionVersion holds the same admission lock and returns the
	// current lifecycle intent. Nil denotes a Worker without lifecycle history.
	WorkerExecutionVersion(context.Context, string, string) (*int64, error)
}

// WorkerExecutionAdmissionScope supplies admission in the caller's transaction.
type WorkerExecutionAdmissionScope interface {
	WorkerExecutionAdmission() WorkerExecutionAdmission
}
