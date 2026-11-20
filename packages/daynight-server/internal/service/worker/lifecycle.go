package worker

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func lifecycleIdentity(principal model.Principal, workerID string) (string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", err
	}
	return model.CanonicalID(workerID)
}

func lifecycleUnavailable(err error) error {
	return &model.Fault{Code: "lifecycle_unavailable", Message: "Worker lifecycle authority is unavailable; query the original operation before another write.", Cause: err}
}

func lifecycleError(err error) error {
	if err == nil {
		return nil
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		return lifecycleUnavailable(err)
	}
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Outcome != store.TransactionNotCommitted || transaction.CleanupFailed) {
		return lifecycleUnavailable(err)
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		return fault
	}
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Worker lifecycle resource was not found.", Cause: err}
	}
	return lifecycleUnavailable(err)
}

func lifecycleRead[T any](ctx context.Context, s *Workers, principal model.Principal, workerID string, read func(store.WorkerLifecycleReader, string, time.Time) (T, error)) (T, error) {
	var zero, result T
	id, err := lifecycleIdentity(principal, workerID)
	if err != nil {
		return zero, err
	}
	database, ok := s.store.(store.WorkerLifecycleStore)
	if !ok {
		return zero, lifecycleUnavailable(nil)
	}
	err = database.ReadWorkerLifecycle(ctx, func(scope store.WorkerLifecycleSnapshot) error {
		if err := s.readAdmission(ctx, scope, principal, scopepolicy.WorkerRead); err != nil {
			return err
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		result, err = read(scope.LifecycleDAO(), id, now)
		return err
	})
	if err != nil {
		return zero, lifecycleError(err)
	}
	return result, nil
}

// lifecycleWrite retains the credential lock and Worker lock through the same
// completion. A computed receipt is never returned after an unknown commit.
func lifecycleWrite[T any](ctx context.Context, s *Workers, principal model.Principal, workerID string, permission scopepolicy.Operation, write func(store.WorkerLifecycleDAO, string, time.Time) (T, error)) (T, error) {
	var zero, result T
	id, err := lifecycleIdentity(principal, workerID)
	if err != nil {
		return zero, err
	}
	database, ok := s.store.(store.WorkerLifecycleStore)
	if !ok {
		return zero, lifecycleUnavailable(nil)
	}
	completion, err := database.WriteWorkerLifecycle(ctx, func(scope store.WorkerLifecycleScope) error {
		if err := s.writeAdmission(ctx, scope, principal, permission, scopepolicy.WorkerRead); err != nil {
			return err
		}
		// Sample freshness only after admission has acquired the serialization lock.
		dao := scope.LifecycleDAO()
		if err := dao.LockWorker(ctx, principal.UserID, id); err != nil {
			return err
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		result, err = write(dao, id, now)
		return err
	})
	if completion.Outcome == store.TransactionCommitted {
		if err != nil {
			return zero, lifecycleUnavailable(err)
		}
		return result, nil
	}
	if completion.Outcome == store.TransactionUnknown || err == nil {
		return zero, lifecycleUnavailable(err)
	}
	return zero, lifecycleError(err)
}

func (s *Workers) Lifecycle(ctx context.Context, p model.Principal, id string) (model.LifecycleResource, error) {
	return lifecycleRead(ctx, s, p, id, func(d store.WorkerLifecycleReader, id string, now time.Time) (model.LifecycleResource, error) {
		return core.LifecycleGet(ctx, d, p.UserID, id, now)
	})
}

func (s *Workers) LifecycleOperation(ctx context.Context, p model.Principal, id, operationID string) (model.LifecycleOperationResult, error) {
	operationID, err := model.CanonicalID(operationID)
	if err != nil {
		return model.LifecycleOperationResult{}, err
	}
	return lifecycleRead(ctx, s, p, id, func(d store.WorkerLifecycleReader, id string, _ time.Time) (model.LifecycleOperationResult, error) {
		return core.LifecycleGetOperation(ctx, d, p.UserID, id, operationID)
	})
}

func (s *Workers) RegisterLifecycle(ctx context.Context, p model.Principal, id string, request model.LifecycleInstanceRequest) (model.LifecycleInstanceReceipt, error) {
	return lifecycleWrite(ctx, s, p, id, scopepolicy.WorkerReport, func(d store.WorkerLifecycleDAO, id string, now time.Time) (model.LifecycleInstanceReceipt, error) {
		return core.LifecycleRegister(ctx, d, p.UserID, id, request, now)
	})
}

func (s *Workers) SetLifecycleIntent(ctx context.Context, p model.Principal, id string, request model.LifecycleIntentRequest) (model.LifecycleIntentReceipt, error) {
	return lifecycleWrite(ctx, s, p, id, scopepolicy.WorkerConfigure, func(d store.WorkerLifecycleDAO, id string, now time.Time) (model.LifecycleIntentReceipt, error) {
		return core.LifecycleIntent(ctx, d, p.UserID, id, request, now)
	})
}

func (s *Workers) ActivateLifecycle(ctx context.Context, p model.Principal, id string, request model.LifecycleActivationRequest) (model.LifecycleActivationReceipt, error) {
	return lifecycleWrite(ctx, s, p, id, scopepolicy.WorkerReport, func(d store.WorkerLifecycleDAO, id string, now time.Time) (model.LifecycleActivationReceipt, error) {
		return core.LifecycleActivate(ctx, d, p.UserID, id, request, now)
	})
}

func (s *Workers) ObserveLifecycle(ctx context.Context, p model.Principal, id string, request model.LifecycleObservationEnvelope) (model.LifecycleObservationReceipt, error) {
	return lifecycleWrite(ctx, s, p, id, scopepolicy.WorkerReport, func(d store.WorkerLifecycleDAO, id string, now time.Time) (model.LifecycleObservationReceipt, error) {
		return core.LifecycleObserve(ctx, d, p.UserID, id, request, now)
	})
}

func (s *Workers) ResolveLifecycle(ctx context.Context, p model.Principal, id, operationID string, request model.LifecycleResolveRequest) (model.LifecycleOperationResult, error) {
	operationID, err := model.CanonicalID(operationID)
	if err != nil {
		return model.LifecycleOperationResult{}, err
	}
	permission := scopepolicy.WorkerReport
	if request.RequestKind == "intent" {
		permission = scopepolicy.WorkerConfigure
	}
	return lifecycleWrite(ctx, s, p, id, permission, func(d store.WorkerLifecycleDAO, id string, now time.Time) (model.LifecycleOperationResult, error) {
		return core.LifecycleResolve(ctx, d, p.UserID, id, operationID, request, now)
	})
}
