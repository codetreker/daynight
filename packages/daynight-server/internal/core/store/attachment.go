package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

type AttachmentQuery struct {
	After *string
	Limit int
}

type AttachmentPage struct {
	Items   []model.Attachment
	HasMore bool
}

const attachmentProjection = `project_id::text, task_id::text, path, content_type, size_bytes, created_at, updated_at`

func scanAttachment(row pgx.Row) (model.Attachment, error) {
	var attachment model.Attachment
	err := row.Scan(&attachment.ProjectID, &attachment.TaskID, &attachment.Path, &attachment.ContentType,
		&attachment.SizeBytes, &attachment.CreatedAt, &attachment.UpdatedAt)
	attachment.CreatedAt = attachment.CreatedAt.UTC()
	attachment.UpdatedAt = attachment.UpdatedAt.UTC()
	return attachment, err
}

func (s *Snapshot) Attachment(ctx context.Context, projectID, taskID, path string) (model.Attachment, error) {
	attachment, err := scanAttachment(s.tx.QueryRow(ctx, `SELECT `+attachmentProjection+` FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND path = $3`, projectID, taskID, path))
	if err != nil {
		return model.Attachment{}, queryError("read attachment", err)
	}
	return attachment, nil
}

func (s *Snapshot) Attachments(ctx context.Context, projectID, taskID string, query AttachmentQuery) (AttachmentPage, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+attachmentProjection+` FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND ($3::text IS NULL OR path > $3 COLLATE "C")
		ORDER BY path LIMIT $4`, projectID, taskID, query.After, query.Limit+1)
	if err != nil {
		return AttachmentPage{}, queryError("list attachments", err)
	}
	defer rows.Close()
	items := make([]model.Attachment, 0)
	for rows.Next() {
		attachment, err := scanAttachment(rows)
		if err != nil {
			return AttachmentPage{}, queryError("list attachments", err)
		}
		items = append(items, attachment)
	}
	if err := rows.Err(); err != nil {
		return AttachmentPage{}, queryError("list attachments", err)
	}
	hasMore := len(items) > query.Limit
	if hasMore {
		items = items[:query.Limit]
	}
	return AttachmentPage{Items: items, HasMore: hasMore}, nil
}

func (s *Snapshot) AttachmentPathConflict(ctx context.Context, projectID, taskID, path string) (bool, error) {
	ancestors := make([]string, 0)
	for index, char := range path {
		if char == '/' {
			ancestors = append(ancestors, path[:index])
		}
	}
	var conflict bool
	err := s.tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM task_attachments
		WHERE project_id = $1 AND task_id = $2
		AND (path = ANY($3::text[]) OR starts_with(path, $4)))`,
		projectID, taskID, ancestors, path+"/").Scan(&conflict)
	if err != nil {
		return false, queryError("check attachment path", err)
	}
	return conflict, nil
}

func (s *Store) PutAttachment(ctx context.Context, attachment model.Attachment) (model.Attachment, bool, error) {
	var result model.Attachment
	var created bool
	err := s.Pool.QueryRow(ctx, `INSERT INTO task_attachments (project_id, task_id, path, content_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (task_id, path) DO UPDATE SET content_type = EXCLUDED.content_type,
			size_bytes = EXCLUDED.size_bytes, updated_at = statement_timestamp()
		RETURNING WITH (OLD AS previous, NEW AS current) current.project_id::text, current.task_id::text,
			current.path, current.content_type, current.size_bytes, current.created_at, current.updated_at,
			previous.task_id IS NULL`,
		attachment.ProjectID, attachment.TaskID, attachment.Path, attachment.ContentType, attachment.SizeBytes).
		Scan(&result.ProjectID, &result.TaskID, &result.Path, &result.ContentType, &result.SizeBytes,
			&result.CreatedAt, &result.UpdatedAt, &created)
	if err != nil {
		return model.Attachment{}, false, queryError("put attachment", err)
	}
	result.CreatedAt = result.CreatedAt.UTC()
	result.UpdatedAt = result.UpdatedAt.UTC()
	return result, created, nil
}

func (s *Store) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	result, err := s.Pool.Exec(ctx, `DELETE FROM task_attachments WHERE project_id = $1 AND task_id = $2 AND path = $3`, projectID, taskID, path)
	if err != nil {
		return queryError("delete attachment", err)
	}
	if result.RowsAffected() == 0 {
		return queryError("delete attachment", model.ErrNotFound)
	}
	return nil
}
