package pg

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func TaskPresence(ctx context.Context, tx pgx.Tx, projectID, taskID, lock string) (store.TaskPresence, error) {
	var presence store.TaskPresence
	relation, deleted := "task_resource_rows", "effective_deleted_at"
	if lock != "" {
		relation, deleted = "tasks", "deleted_at"
	}
	err := tx.QueryRow(ctx, `SELECT `+deleted+` FROM `+relation+` WHERE project_id=$1 AND id=$2`+lock, projectID, taskID).Scan(&presence.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return presence, nil
	}
	if err != nil {
		return store.TaskPresence{}, QueryError("read task presence", err)
	}
	presence.Found = true
	presence.DeletedAt = UTCTime(presence.DeletedAt)
	return presence, nil
}

const ThreadMessageProjection = `task_id::text,message_id::text,created_at,author_user_id::text,
 author_display_name,author_agent,author_claim_id::text,author_worker_id::text,author_provider,body,reply_to_message_id::text`

func ScanThreadMessage(row pgx.Row) (model.ThreadMessage, error) {
	var message model.ThreadMessage
	var claimID, workerID, provider *string
	err := row.Scan(&message.TaskID, &message.ID, &message.CreatedAt, &message.Author.UserID,
		&message.Author.DisplayName, &message.Author.Agent, &claimID, &workerID, &provider, &message.Body, &message.ReplyTo)
	if err != nil {
		return model.ThreadMessage{}, err
	}
	if claimID != nil && workerID != nil && provider != nil {
		message.Author.Execution = &model.ThreadExecution{ClaimID: *claimID, WorkerID: *workerID, Provider: *provider}
	}
	message.CreatedAt = message.CreatedAt.UTC()
	return message, nil
}

func ReadThreadMessage(ctx context.Context, tx pgx.Tx, taskID, id string) (model.ThreadMessage, error) {
	message, err := ScanThreadMessage(tx.QueryRow(ctx, `SELECT `+ThreadMessageProjection+`
 FROM task_thread_messages WHERE task_id=$1 AND message_id=$2`, taskID, id))
	if err != nil {
		return model.ThreadMessage{}, QueryError("read thread message", err)
	}
	return message, nil
}
