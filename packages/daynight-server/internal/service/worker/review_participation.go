package worker

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func (s *Workers) ReviewParticipation(ctx context.Context, principal model.Principal, workerID string) (model.WorkerReviewParticipation, error) {
	var result model.WorkerReviewParticipation
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		result, err = workercore.ReadReviewParticipation(ctx, scope.WorkerDAO(), principal, workerID)
		return err
	})
	if err != nil {
		return model.WorkerReviewParticipation{}, workerConfigurationError("get worker review participation", err)
	}
	return result, nil
}

func (s *Workers) PutReviewParticipation(ctx context.Context, principal model.Principal, workerID, expectedVersion string, enabled bool) (model.WorkerReviewParticipation, error) {
	expected, err := workercore.ReviewParticipationVersion(expectedVersion)
	if err != nil {
		return model.WorkerReviewParticipation{}, err
	}
	var result model.WorkerReviewParticipation
	completion, err := s.store.WriteWorker(ctx, func(scope store.WorkerScope) error {
		var err error
		result, err = workercore.PutReviewParticipation(ctx, scope.WorkerDAO(), principal, workerID, expected, enabled)
		return err
	})
	if err != nil {
		return model.WorkerReviewParticipation{}, workerConfigurationError("save worker review participation", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.WorkerReviewParticipation{}, fmt.Errorf("save worker review participation: transaction did not confirm commit")
	}
	return result, nil
}
