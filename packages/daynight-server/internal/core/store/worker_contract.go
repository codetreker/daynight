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
	WorkerDAO() WorkerWriteDAO
}

type WorkerWriteDAO interface {
	ReportTaskSnapshots(context.Context, string, model.WorkerTaskInventory) ([]WorkerTaskSource, error)
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

var _ WorkerWriter = (*Store)(nil)
var _ WorkerScope = (*workerTx)(nil)
var _ WorkerWriteDAO = (*workerTx)(nil)
