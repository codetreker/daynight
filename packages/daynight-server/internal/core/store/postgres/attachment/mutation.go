package attachment

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Writer executes attachment mutations without acquiring a Project row lock.
type Writer struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Writer { return &Writer{pool: pool} }

var _ store.AttachmentMutationWriter = (*Writer)(nil)
var _ store.AttachmentMutationScope = (*scope)(nil)
var _ store.AttachmentMutationDAO = (*scope)(nil)

type scope struct{ tx pgx.Tx }

func (w *Writer) WriteAttachmentMutation(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
	tx, err := w.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, databaseError("begin attachment mutation", err)
	}
	return transact(ctx, tx, operation)
}

func transact(ctx context.Context, tx pgx.Tx, operation func(store.AttachmentMutationScope) error) (completion store.Completion, err error) {
	completion.Outcome = store.TransactionUnknown
	stage := &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		rollbackErr := tx.Rollback(cleanup)
		if rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			stage.Phase, stage.CleanupFailed = "cleanup", true
			stage.Cause = errors.Join(stage.Cause, rollbackErr)
			err = stage
		} else if !stage.CommitAttempted && rollbackErr == nil {
			completion.Outcome = store.TransactionNotCommitted
			stage.Outcome = completion.Outcome
		}
	}()
	if cause := operation(&scope{tx: tx}); cause != nil {
		stage.Cause = cause
		return completion, stage
	}
	if cause := ctx.Err(); cause != nil {
		stage.Cause = cause
		return completion, stage
	}
	stage.Phase, stage.CommitAttempted = "commit", true
	if cause := tx.Commit(ctx); cause != nil {
		stage.Cause = cause
		if errors.Is(cause, pgx.ErrTxCommitRollback) {
			completion.Outcome = store.TransactionNotCommitted
			stage.Outcome = completion.Outcome
		}
		return completion, stage
	}
	completion.Outcome = store.TransactionCommitted
	stage.Outcome = completion.Outcome
	return completion, nil
}

func databaseError(phase string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.Join(model.ErrNotFound, err)
	}
	return &store.Error{Phase: phase, Cause: err}
}

// The lock includes deleted rows so callers can authorize before revealing the
// deletion state, including when a waiting deletion commits first.
func (s *scope) LockTaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	var result store.TaskPresence
	err := s.tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE`, projectID, taskID).Scan(&result.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return store.TaskPresence{}, databaseError("lock attachment task", err)
	}
	result.Found = true
	if result.DeletedAt != nil {
		utc := result.DeletedAt.UTC()
		result.DeletedAt = &utc
	}
	return result, nil
}

func (s *scope) ProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	return store.LockProjectAuthorization(ctx, s.tx, principal.UserID, projectID)
}

func (s *scope) AttachmentDAO() store.AttachmentMutationDAO { return s }
