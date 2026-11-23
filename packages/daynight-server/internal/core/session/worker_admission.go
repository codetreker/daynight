package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RequireWorkerExecution checks the bound Worker in the current transaction.
// Independent Test Sessions have no Worker and retain their own authorization.
func RequireWorkerExecution(ctx context.Context, scope store.SessionScope, owner, worker string) error {
	if worker == "" {
		return nil
	}
	admission, ok := scope.(store.WorkerExecutionAdmissionScope)
	if !ok {
		return fault("lifecycle_unavailable", "Worker execution authority is unavailable.")
	}
	return admission.WorkerExecutionAdmission().CheckWorkerExecution(ctx, owner, worker)
}

func commandWorkerVersion(ctx context.Context, tx *operationTx, r *record, kind string) (*int64, error) {
	if kind == "cancel" || r.ExecutionWorkerID == "" {
		return nil, nil
	}
	admission, ok := tx.scope.(store.WorkerExecutionAdmissionScope)
	if !ok {
		return nil, fault("lifecycle_unavailable", "Worker execution authority is unavailable.")
	}
	return admission.WorkerExecutionAdmission().WorkerExecutionVersion(ctx, r.Owner, r.ExecutionWorkerID)
}
func requireOperationWorker(ctx context.Context, tx *operationTx, r *record, o operationRecord) error {
	current, err := commandWorkerVersion(ctx, tx, r, o.Command.Kind)
	if err != nil {
		return err
	}
	original := o.WorkerIntentVersion
	// Version counters are local to each Worker; a Bot hosting transfer cannot
	// turn an old host's queued input into permission on the replacement.
	if o.WorkerID != nil && *o.WorkerID != r.ExecutionWorkerID || original != nil && o.WorkerID == nil {
		return fault("worker_disabled", "Worker ownership changed before dispatch.")
	}
	if current == nil && original == nil || current != nil && original != nil && *current == *original {
		return nil
	}
	return fault("worker_disabled", "Worker lifecycle changed before dispatch.")
}
