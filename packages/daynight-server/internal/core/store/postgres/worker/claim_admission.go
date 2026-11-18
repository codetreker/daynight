package worker

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type ClaimAdmission struct{ tx pgx.Tx }

func NewClaimAdmission(tx pgx.Tx) store.WorkerClaimAdmissionDAO {
	return &ClaimAdmission{tx: tx}
}

func (dao *ClaimAdmission) ClaimWorkerConfiguration(ctx context.Context, userID, workerID string) (*model.WorkerDesiredConfiguration, error) {
	desired, err := dao.lockConfiguration(ctx, userID, workerID)
	if !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			return nil, pg.QueryError("lock claim worker configuration", err)
		}
		return desired, nil
	}
	// No Worker row is held on this path. Matching first-report admission's
	// owner lock prevents insertion until the enclosing Project transaction ends.
	if err := lockOwnerAdmission(ctx, dao.tx, userID); err != nil {
		return nil, err
	}
	desired, err = dao.lockConfiguration(ctx, userID, workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("lock claim worker configuration", err)
	}
	return desired, nil
}

func (dao *ClaimAdmission) lockConfiguration(ctx context.Context, userID, workerID string) (*model.WorkerDesiredConfiguration, error) {
	var revision *int64
	var updatedAt *time.Time
	var raw []byte
	if err := dao.tx.QueryRow(ctx, `SELECT configuration_revision,configuration_updated_at,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE`, userID, workerID).Scan(&revision, &updatedAt, &raw); err != nil {
		return nil, err
	}
	if revision == nil {
		return nil, nil
	}
	return &model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(*revision, 10), UpdatedAt: updatedAt.UTC(), Raw: raw}, nil
}
