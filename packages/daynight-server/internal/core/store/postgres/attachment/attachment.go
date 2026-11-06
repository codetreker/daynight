package attachment

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Reader and Writer bind attachment metadata access to a transaction or pool.
type Reader struct{ tx pgx.Tx }
type Writer struct{ pool *pgxpool.Pool }

func NewReader(tx pgx.Tx) store.AttachmentReader          { return &Reader{tx: tx} }
func NewWriter(pool *pgxpool.Pool) store.AttachmentWriter { return &Writer{pool: pool} }

var _ store.AttachmentReader = (*Reader)(nil)
var _ store.AttachmentWriter = (*Writer)(nil)

const attachmentProjection = `project_id::text, task_id::text, path, content_type, size_bytes, created_at, updated_at`

func scanAttachment(row pgx.Row) (model.Attachment, error) {
	var attachment model.Attachment
	err := row.Scan(&attachment.ProjectID, &attachment.TaskID, &attachment.Path, &attachment.ContentType,
		&attachment.SizeBytes, &attachment.CreatedAt, &attachment.UpdatedAt)
	attachment.CreatedAt = attachment.CreatedAt.UTC()
	attachment.UpdatedAt = attachment.UpdatedAt.UTC()
	return attachment, err
}

func (s *Reader) Attachment(ctx context.Context, projectID, taskID, path string) (model.Attachment, error) {
	attachment, err := scanAttachment(s.tx.QueryRow(ctx, `SELECT `+attachmentProjection+` FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND path = $3`, projectID, taskID, path))
	if err != nil {
		return model.Attachment{}, pg.QueryError("read attachment", err)
	}
	return attachment, nil
}

func (s *Reader) Attachments(ctx context.Context, projectID, taskID string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	rows, err := s.tx.Query(ctx, `SELECT project_id::text, task_id::text,
		CASE WHEN $5::integer = 0 OR octet_length(path) <= $5 THEN path ELSE '' END,
		CASE WHEN $5::integer = 0 OR octet_length(content_type) <= $5 THEN content_type ELSE '' END,
		size_bytes, created_at, updated_at,
		($5::integer > 0 AND (octet_length(path) > $5 OR octet_length(content_type) > $5))
		FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND ($3::text IS NULL OR path > $3 COLLATE "C")
		ORDER BY path LIMIT $4`, projectID, taskID, query.After, query.Limit+1, query.MaxFieldBytes)
	if err != nil {
		return store.AttachmentPage{}, pg.QueryError("list attachments", err)
	}
	defer rows.Close()
	items := make([]model.Attachment, 0)
	oversized := make([]bool, 0)
	for rows.Next() {
		var attachment model.Attachment
		var tooLarge bool
		err := rows.Scan(&attachment.ProjectID, &attachment.TaskID, &attachment.Path, &attachment.ContentType,
			&attachment.SizeBytes, &attachment.CreatedAt, &attachment.UpdatedAt, &tooLarge)
		if err != nil {
			return store.AttachmentPage{}, pg.QueryError("list attachments", err)
		}
		attachment.CreatedAt = attachment.CreatedAt.UTC()
		attachment.UpdatedAt = attachment.UpdatedAt.UTC()
		items = append(items, attachment)
		oversized = append(oversized, tooLarge)
	}
	if err := rows.Err(); err != nil {
		return store.AttachmentPage{}, pg.QueryError("list attachments", err)
	}
	hasMore := len(items) > query.Limit
	if hasMore {
		items = items[:query.Limit]
		oversized = oversized[:query.Limit]
	}
	if query.MaxFieldBytes == 0 {
		oversized = nil
	}
	return store.AttachmentPage{Items: items, HasMore: hasMore, Oversized: oversized}, nil
}

func (s *Reader) AttachmentPathConflict(ctx context.Context, projectID, taskID string, query store.AttachmentConflictQuery) (bool, error) {
	var conflict bool
	err := s.tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM task_attachments
		WHERE project_id = $1 AND task_id = $2
		AND (path = ANY($3::text[]) OR starts_with(path, $4)))`,
		projectID, taskID, query.Ancestors, query.DescendantPrefix).Scan(&conflict)
	if err != nil {
		return false, pg.QueryError("check attachment path", err)
	}
	return conflict, nil
}

type mutationQueries interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (s *Writer) PutAttachment(ctx context.Context, attachment model.Attachment) (model.Attachment, bool, error) {
	return putAttachment(ctx, s.pool, attachment)
}

func putAttachment(ctx context.Context, db mutationQueries, attachment model.Attachment) (model.Attachment, bool, error) {
	var result model.Attachment
	var created bool
	err := db.QueryRow(ctx, `INSERT INTO task_attachments (project_id, task_id, path, content_type, size_bytes)
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
		return model.Attachment{}, false, pg.QueryError("put attachment", err)
	}
	result.CreatedAt = result.CreatedAt.UTC()
	result.UpdatedAt = result.UpdatedAt.UTC()
	return result, created, nil
}

func (s *Writer) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	return deleteAttachment(ctx, s.pool, projectID, taskID, path)
}

func deleteAttachment(ctx context.Context, db mutationQueries, projectID, taskID, path string) error {
	result, err := db.Exec(ctx, `DELETE FROM task_attachments WHERE project_id = $1 AND task_id = $2 AND path = $3`, projectID, taskID, path)
	if err != nil {
		return pg.QueryError("delete attachment", err)
	}
	if result.RowsAffected() == 0 {
		return pg.QueryError("delete attachment", model.ErrNotFound)
	}
	return nil
}
