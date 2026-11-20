package worker

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func workerConfigurationError(operation string, err error) error {
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		return fmt.Errorf("%s: %w", operation, err)
	}
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		return fault
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func configurationNotFound(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	return err
}

func (s *Workers) Configuration(ctx context.Context, principal model.Principal, workerID string) (model.WorkerConfigurationResource, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	workerID, err := model.CanonicalID(workerID)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	var result model.WorkerConfigurationResource
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result, err = snapshot.WorkerDAO().WorkerConfiguration(ctx, principal.UserID, workerID)
		if err = configurationNotFound(err); err != nil {
			return err
		}
		if s.authorization != nil {
			authorization, err := s.authorization.Read(ctx, snapshot, principal)
			return requireAuthorization(principal, authorization, err, scopepolicy.WorkerRead)
		}
		return nil
	})
	if err != nil {
		return model.WorkerConfigurationResource{}, workerConfigurationError("get worker configuration", err)
	}
	return result, nil
}

func (s *Workers) PutConfiguration(ctx context.Context, principal model.Principal, workerID, revision string, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	workerID, err := model.CanonicalID(workerID)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	expected, err := workercore.ConfigurationRevision(revision, false)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	value, err = workercore.NormalizeConfiguration(value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	var result model.WorkerConfigurationResource
	completion, err := s.store.WriteWorker(ctx, func(scope store.WorkerScope) error {
		if s.authorization != nil {
			authorization, err := s.authorization.WorkerWrite(ctx, scope, principal)
			if err := requireAuthorization(principal, authorization, err, scopepolicy.WorkerConfigure, scopepolicy.WorkerRead); err != nil {
				return err
			}
		}
		var err error
		result, err = s.putConfiguration(ctx, scope.WorkerDAO(), principal, workerID, expected, value)
		return err
	})
	if err != nil {
		return model.WorkerConfigurationResource{}, workerConfigurationError("save worker configuration", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.WorkerConfigurationResource{}, fmt.Errorf("save worker configuration: transaction did not confirm commit")
	}
	return result, nil
}
