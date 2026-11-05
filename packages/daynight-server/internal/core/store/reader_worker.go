package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type WorkerReader interface {
	Workers(context.Context, string, time.Time, Page) (WorkerPage, error)
	Worker(context.Context, string, string, time.Time) (model.WorkerSnapshot, error)
	WorkerConfiguration(context.Context, string, string) (model.WorkerConfigurationResource, error)
}
