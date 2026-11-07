package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// WorkerWriter binds the worker operations to a single ReadCommitted write.
// The scope and its DAO are valid only until the callback returns.
type WorkerWriter interface {
	WriteWorker(context.Context, func(WorkerScope) error) (Completion, error)
}

type WorkerScope interface {
	ObservedAt(context.Context) (time.Time, error)
	// AdmitWorker locks the owner until transaction completion, then samples the
	// database clock and reads the target timestamp and complete active count.
	AdmitWorker(context.Context, string, string, time.Duration) (WorkerAdmission, error)
	WorkerDAO() WorkerWriteDAO
}

type WorkerAdmission struct {
	ObservedAt  time.Time
	LastSeenAt  *time.Time
	ActiveCount int
}

type WorkerWriteDAO interface {
	ReportTaskSnapshots(context.Context, string, model.WorkerTaskInventory) ([]WorkerTaskSource, error)
	// UpsertWorker requires admission for the same owner in this transaction;
	// its report timestamp must be the locked admission observation.
	UpsertWorker(context.Context, model.WorkerSnapshot) (model.WorkerSnapshot, error)
	WorkerConfiguration(context.Context, string, string) (model.WorkerConfigurationResource, error)
	ConfigurationProjectAccess(context.Context, string, string) error
	SetWorkerConfiguration(context.Context, string, string, int64, model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error)
	SetWorkerConfigurationObservation(context.Context, string, string, int64, model.WorkerConfigurationObservation) error
}

// WorkerTaskSource is one accessible current Task and its owning Project name.
type WorkerTaskSource struct {
	Task        model.Task
	ProjectName string
}
