package attachment

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

const projection = `project_id::text, task_id::text, path, content_type, size_bytes, created_at, updated_at`

func scan(row pgx.Row) (model.Attachment, error) {
	var result model.Attachment
	err := row.Scan(&result.ProjectID, &result.TaskID, &result.Path, &result.ContentType, &result.SizeBytes, &result.CreatedAt, &result.UpdatedAt)
	result.CreatedAt = result.CreatedAt.UTC()
	result.UpdatedAt = result.UpdatedAt.UTC()
	return result, err
}

func (s *scope) Attachment(ctx context.Context, projectID, taskID, path string) (model.Attachment, error) {
	result, err := scan(s.tx.QueryRow(ctx, `SELECT `+projection+` FROM task_attachments WHERE project_id=$1 AND task_id=$2 AND path=$3`, projectID, taskID, path))
	if err != nil {
		return model.Attachment{}, databaseError("read attachment", err)
	}
	return result, nil
}

func (s *scope) Attachments(ctx context.Context, projectID, taskID string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+projection+` FROM task_attachments
		WHERE project_id=$1 AND task_id=$2 AND ($3::text IS NULL OR path > $3 COLLATE "C") ORDER BY path LIMIT $4`, projectID, taskID, query.After, query.Limit+1)
	if err != nil {
		return store.AttachmentPage{}, databaseError("list attachments", err)
	}
	defer rows.Close()
	items := make([]model.Attachment, 0)
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return store.AttachmentPage{}, databaseError("list attachments", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return store.AttachmentPage{}, databaseError("list attachments", err)
	}
	more := len(items) > query.Limit
	if more {
		items = items[:query.Limit]
	}
	return store.AttachmentPage{Items: items, HasMore: more}, nil
}

func (s *scope) AttachmentPathConflict(ctx context.Context, projectID, taskID string, query store.AttachmentConflictQuery) (bool, error) {
	var conflict bool
	err := s.tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM task_attachments WHERE project_id=$1 AND task_id=$2
		AND (path = ANY($3::text[]) OR starts_with(path, $4)))`, projectID, taskID, query.Ancestors, query.DescendantPrefix).Scan(&conflict)
	if err != nil {
		return false, databaseError("check attachment path", err)
	}
	return conflict, nil
}

func (s *scope) PutAttachment(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
	var result model.Attachment
	var created bool
	err := s.tx.QueryRow(ctx, `INSERT INTO task_attachments (project_id, task_id, path, content_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (task_id, path) DO UPDATE SET content_type = EXCLUDED.content_type,
			size_bytes = EXCLUDED.size_bytes, updated_at = statement_timestamp()
		RETURNING WITH (OLD AS previous, NEW AS current) current.project_id::text, current.task_id::text,
			current.path, current.content_type, current.size_bytes, current.created_at, current.updated_at,
			previous.task_id IS NULL`, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.SizeBytes).
		Scan(&result.ProjectID, &result.TaskID, &result.Path, &result.ContentType, &result.SizeBytes, &result.CreatedAt, &result.UpdatedAt, &created)
	if err != nil {
		return model.Attachment{}, false, databaseError("put attachment", err)
	}
	result.CreatedAt = result.CreatedAt.UTC()
	result.UpdatedAt = result.UpdatedAt.UTC()
	return result, created, nil
}

func (s *scope) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	result, err := s.tx.Exec(ctx, `DELETE FROM task_attachments WHERE project_id=$1 AND task_id=$2 AND path=$3`, projectID, taskID, path)
	if err != nil {
		return databaseError("delete attachment", err)
	}
	if result.RowsAffected() == 0 {
		return databaseError("delete attachment", model.ErrNotFound)
	}
	return nil
}
