package worker

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Workers) ReviewEnabled(ctx context.Context, principal model.Principal, workerID string) (bool, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return false, err
	}
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return false, err
	}
	var enabled bool
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		enabled, err = scope.WorkerDAO().WorkerReviewEnabled(ctx, principal.UserID, id)
		return configurationNotFound(err)
	})
	if err != nil {
		return false, workerConfigurationError("read worker review setting", err)
	}
	return enabled, nil
}

func (s *Workers) SetReviewEnabled(ctx context.Context, principal model.Principal, workerID string, enabled bool) (bool, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return false, err
	}
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return false, err
	}
	var stored bool
	completion, err := s.store.WriteWorker(ctx, func(scope store.WorkerScope) error {
		var err error
		stored, err = scope.WorkerDAO().SetWorkerReviewEnabled(ctx, principal.UserID, id, enabled)
		return configurationNotFound(err)
	})
	if err != nil {
		return false, workerConfigurationError("save worker review setting", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return false, fmt.Errorf("save worker review setting: transaction did not confirm commit")
	}
	return stored, nil
}
