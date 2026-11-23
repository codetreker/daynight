package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

var _ store.ArchiveCleanupStore = (*Store)(nil)

func (s *Store) ListArchiveCleanup(ctx context.Context, after string, limit int) ([]store.ArchiveCleanupTarget, error) {
	if limit < 1 || limit > 100 {
		return nil, &model.Fault{Code: "invalid_input", Message: "Invalid archive cleanup page limit."}
	}
	if after != "" {
		if _, err := model.CanonicalID(after); err != nil {
			return nil, err
		}
	}
	rows, err := s.Pool.Query(ctx, `SELECT s.project_id::text,s.task_id::text,s.id::text,s.owner_user_id::text,r.expired_at,r.cleaned_at
 FROM session_archive_retention r JOIN task_sessions s ON s.id=r.session_id
 JOIN task_resource_rows t ON t.id=s.task_id AND t.project_id=s.project_id
 JOIN projects p ON p.id=s.project_id
 WHERE r.cleaned_at IS NULL AND s.scope='task' AND s.backend='web' AND s.bot_id IS NULL
 AND t.type='task' AND (r.expired_at IS NOT NULL OR (t.effective_deleted_at IS NULL AND p.deleted_at IS NULL))
 AND ($1::text='' OR s.id>NULLIF($1,'')::uuid) ORDER BY s.id LIMIT $2`, after, limit)
	if err != nil {
		return nil, pg.QueryError("list archive cleanup", err)
	}
	defer rows.Close()
	out := []store.ArchiveCleanupTarget{}
	for rows.Next() {
		var target store.ArchiveCleanupTarget
		if err := rows.Scan(&target.ProjectID, &target.TaskID, &target.SessionID, &target.OwnerID, &target.ExpiredAt, &target.CleanedAt); err != nil {
			return nil, pg.QueryError("scan archive cleanup", err)
		}
		out = append(out, target)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list archive cleanup", err)
	}
	return out, nil
}

func (s *Store) WriteArchiveCleanup(ctx context.Context, target store.ArchiveCleanupTarget, operation func(store.ArchiveCleanupScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin archive cleanup", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var project string
		if err := tx.QueryRow(ctx, `SELECT p.id::text FROM projects p WHERE p.id=$1 AND (p.deleted_at IS NULL OR EXISTS(
 SELECT 1 FROM session_archive_retention r JOIN task_sessions s ON s.id=r.session_id
 WHERE s.id=$2 AND s.project_id=p.id AND r.expired_at IS NOT NULL)) FOR SHARE OF p`, target.ProjectID, target.SessionID).Scan(&project); err != nil {
			return pg.QueryError("lock archive cleanup project", err)
		}
		scope, err := session.NewArchiveCleanup(ctx, tx, target)
		if err != nil {
			return err
		}
		return operation(scope)
	})
	return teamCompletion("write archive cleanup", err)
}
