package worker

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.WorkerProjectSelectionDAO = (*Writer)(nil)

func (w *Writer) ProjectSelectionCandidates(ctx context.Context, projectID string) ([]store.WorkerSelectionID, error) {
	rows, err := w.tx.Query(ctx, `SELECT user_id::text,worker_id::text FROM workers
		WHERE configuration_revision IS NOT NULL AND desired_configuration @> jsonb_build_object('projects',jsonb_build_array(jsonb_build_object('projectId',$1::text)))
		ORDER BY user_id,worker_id`, projectID)
	if err != nil {
		return nil, pg.QueryError("select worker project configurations", err)
	}
	defer rows.Close()
	var ids []store.WorkerSelectionID
	for rows.Next() {
		var id store.WorkerSelectionID
		if err := rows.Scan(&id.UserID, &id.WorkerID); err != nil {
			return nil, pg.QueryError("select worker project configurations", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("select worker project configurations", err)
	}
	return ids, nil
}

func (w *Writer) LockProjectSelection(ctx context.Context, id store.WorkerSelectionID) (*store.WorkerSelectionTarget, error) {
	var revision *int64
	var raw []byte
	err := w.tx.QueryRow(ctx, `SELECT configuration_revision,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE`, id.UserID, id.WorkerID).Scan(&revision, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("lock worker project configuration", err)
	}
	if revision == nil {
		return nil, nil
	}
	return &store.WorkerSelectionTarget{Revision: *revision, Raw: raw}, nil
}

func (w *Writer) SaveProjectSelection(ctx context.Context, id store.WorkerSelectionID, revision int64, raw json.RawMessage) error {
	_, err := w.tx.Exec(ctx, `UPDATE workers SET configuration_revision=$3,configuration_updated_at=statement_timestamp(),desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2`, id.UserID, id.WorkerID, revision, raw)
	if err != nil {
		return pg.QueryError("save worker project configuration", err)
	}
	return nil
}
