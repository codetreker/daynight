package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenOfflineStorageMigration checks the candidate schema without running DDL
// or background application work. Only the restored destination is writable.
func OpenOfflineStorageMigration(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, databaseFailure("configuration", err)
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		pool.Close()
		return nil, databaseFailure("connect", err)
	}
	count, err := appliedMigrations(ctx, connection, schemaMigrations)
	connection.Release()
	if err == nil && count != len(schemaMigrations) {
		err = errors.New("offline migration database requires the candidate schema")
	}
	if err != nil {
		pool.Close()
		return nil, databaseFailure("offline migration reader version", err)
	}
	return &Store{Pool: pool}, nil
}

// VerifyOfflineAttachments includes retained attachments independently of Task
// and Goal visibility. A soft deletion does not remove the underlying objects.
func (s *Store) VerifyOfflineAttachments(ctx context.Context, verify func(model.Attachment) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `SELECT project_id::text,task_id::text,path,content_type,size_bytes,created_at,updated_at FROM task_attachments ORDER BY project_id,task_id,path COLLATE "C"`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var a model.Attachment
		if err = rows.Scan(&a.ProjectID, &a.TaskID, &a.Path, &a.ContentType, &a.SizeBytes, &a.CreatedAt, &a.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		if err = verify(a); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
