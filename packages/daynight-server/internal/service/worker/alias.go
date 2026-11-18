package worker

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func (s *Workers) Alias(ctx context.Context, principal model.Principal, workerID string) (model.WorkerAlias, error) {
	var result model.WorkerAlias
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		result, err = workercore.ReadAlias(ctx, scope.WorkerDAO(), principal, workerID)
		return err
	})
	if err != nil {
		return model.WorkerAlias{}, workerConfigurationError("get worker alias", err)
	}
	return result, nil
}

func (s *Workers) PutAlias(ctx context.Context, principal model.Principal, workerID, expectedVersion string, value *string) (model.WorkerAlias, error) {
	expected, err := workercore.AliasVersion(expectedVersion)
	if err != nil {
		return model.WorkerAlias{}, err
	}
	var result model.WorkerAlias
	completion, err := s.store.WriteWorker(ctx, func(scope store.WorkerScope) error {
		var err error
		result, err = workercore.PutAlias(ctx, scope.WorkerDAO(), principal, workerID, expected, value)
		return err
	})
	if err != nil {
		return model.WorkerAlias{}, workerConfigurationError("save worker alias", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.WorkerAlias{}, fmt.Errorf("save worker alias: transaction did not confirm commit")
	}
	return result, nil
}
