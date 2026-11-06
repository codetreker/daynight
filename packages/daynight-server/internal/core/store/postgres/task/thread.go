package task

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	return pg.TaskPresence(ctx, s.tx, projectID, taskID, "")
}

func (s *Reader) ThreadMessage(ctx context.Context, taskID, id string) (model.ThreadMessage, error) {
	return pg.ReadThreadMessage(ctx, s.tx, taskID, id)
}

// ThreadCandidates returns at most limit candidates in traversal order and closes
// its rows before returning, so callers may query page sides on the same connection.
func (s *Reader) ThreadCandidates(ctx context.Context, taskID string, anchor *model.ThreadPosition, before bool, limit int) ([]model.ThreadMessage, error) {
	var anchorTime, anchorID any
	if anchor != nil {
		anchorTime, anchorID = anchor.CreatedAt, anchor.ID
	}
	comparison, order := ">", "ASC"
	if before {
		comparison, order = "<", "DESC"
	}
	rows, err := s.tx.Query(ctx, `SELECT `+pg.ThreadMessageProjection+` FROM task_thread_messages
 WHERE task_id=$1 AND ($2::timestamptz IS NULL OR (created_at,message_id) `+comparison+` ($2,$3::uuid))
 ORDER BY created_at `+order+`,message_id `+order+` LIMIT $4`, taskID, anchorTime, anchorID, limit)
	if err != nil {
		return nil, pg.QueryError("read thread candidates", err)
	}
	defer rows.Close()
	items := make([]model.ThreadMessage, 0)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, pg.QueryError("read thread candidates", err)
		}
		message, err := pg.ScanThreadMessage(rows)
		if err != nil {
			return nil, pg.QueryError("read thread candidates", err)
		}
		items = append(items, message)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read thread candidates", err)
	}
	return items, nil
}

func (s *Reader) ThreadSides(ctx context.Context, taskID string, first, last model.ThreadPosition) (bool, bool, error) {
	var before, after bool
	err := s.tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM task_thread_messages WHERE task_id=$1 AND (created_at,message_id)<($2,$3::uuid)),
 EXISTS(SELECT 1 FROM task_thread_messages WHERE task_id=$1 AND (created_at,message_id)>($4,$5::uuid))`,
		taskID, first.CreatedAt, first.ID, last.CreatedAt, last.ID).Scan(&before, &after)
	if err != nil {
		return false, false, pg.QueryError("read thread page sides", err)
	}
	return before, after, nil
}
