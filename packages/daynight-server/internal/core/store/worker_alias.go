package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type WorkerAliasReader interface {
	WorkerAlias(context.Context, string, string) (model.WorkerAlias, error)
}

type WorkerAliasWriter interface {
	WorkerAliasReader
	// SetWorkerAlias compares the observed version even for an unchanged value.
	SetWorkerAlias(context.Context, string, string, int64, model.WorkerAlias) error
}
