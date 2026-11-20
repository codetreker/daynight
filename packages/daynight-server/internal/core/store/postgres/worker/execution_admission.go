package worker

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type ExecutionAdmission struct{ tx pgx.Tx }

func NewExecutionAdmission(tx pgx.Tx) store.WorkerExecutionAdmission {
	return &ExecutionAdmission{tx: tx}
}

func (a *ExecutionAdmission) CheckWorkerExecution(ctx context.Context, userID, workerID string) error {
	_, err := a.WorkerExecutionVersion(ctx, userID, workerID)
	return err
}
func (a *ExecutionAdmission) WorkerExecutionVersion(ctx context.Context, userID, workerID string) (*int64, error) {
	// The claim reader also fences an absent Worker against its first report.
	// Its lock survives the subsequent lifecycle read and the business write.
	if _, err := NewClaimAdmission(a.tx).ClaimWorkerConfiguration(ctx, userID, workerID); err != nil {
		return nil, &model.Fault{Code: "lifecycle_unavailable", Message: "Worker execution authority is unavailable.", Cause: err}
	}
	var admission string
	var version int64
	err := a.tx.QueryRow(ctx, `SELECT admission,intent_version FROM worker_lifecycle WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&admission, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, &model.Fault{Code: "lifecycle_unavailable", Message: "Worker execution authority is unavailable.", Cause: err}
	}
	if admission != "open" {
		return nil, &model.Fault{Code: "worker_disabled", Message: "Worker is not accepting execution."}
	}
	return &version, nil
}

func (a *ClaimAdmission) CheckWorkerExecution(ctx context.Context, userID, workerID string) error {
	return NewExecutionAdmission(a.tx).CheckWorkerExecution(ctx, userID, workerID)
}

func (a *ClaimAdmission) WorkerExecutionVersion(ctx context.Context, user, worker string) (*int64, error) {
	return NewExecutionAdmission(a.tx).WorkerExecutionVersion(ctx, user, worker)
}
