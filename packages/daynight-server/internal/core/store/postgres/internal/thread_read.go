package pg

import (
	"context"
	"errors"
	"fmt"
	"sort"

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

// LockTaskResource acquires the final row modes in the same UUID order used by
// project deletion. The parent is only a lock plan until it is read again
// after the locks; a changed plan must not acquire a late, out-of-order lock.
func LockTaskResource(ctx context.Context, tx pgx.Tx, projectID, taskID string, update bool) (store.TaskPresence, error) {
	var target string
	var parent *string
	err := tx.QueryRow(ctx, `SELECT id::text,parent_id::text FROM tasks WHERE project_id=$1 AND id=$2`, projectID, taskID).Scan(&target, &parent)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.TaskPresence{}, nil
	}
	if err != nil {
		return store.TaskPresence{}, QueryError("read task resource lock plan", err)
	}
	ids := []string{target}
	if parent != nil && *parent != target {
		ids = append(ids, *parent)
	}
	sort.Strings(ids)
	for _, id := range ids {
		mode := " FOR SHARE"
		if id == target && update {
			mode = " FOR UPDATE"
		}
		var locked string
		err := tx.QueryRow(ctx, `SELECT id::text FROM tasks WHERE project_id=$1 AND id=$2`+mode, projectID, id).Scan(&locked)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return store.TaskPresence{}, QueryError("lock task resource", err)
		}
	}
	var currentParent, parentType *string
	var taskType string
	var presence store.TaskPresence
	err = tx.QueryRow(ctx, `SELECT parent_id::text,type,parent_type,effective_deleted_at FROM task_resource_rows WHERE project_id=$1 AND id=$2`, projectID, target).Scan(&currentParent, &taskType, &parentType, &presence.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !sameParent(parent, currentParent)) {
		return store.TaskPresence{}, &model.Fault{Code: "resource_conflict", Message: "Task parent changed during resource acquisition."}
	}
	if err != nil {
		return store.TaskPresence{}, QueryError("read locked task resource", err)
	}
	if currentParent != nil && (taskType != "task" || parentType == nil || *parentType != "goal") {
		return store.TaskPresence{}, QueryError("read locked task resource", fmt.Errorf("invalid task parent"))
	}
	presence.Found = true
	presence.DeletedAt = UTCTime(presence.DeletedAt)
	return presence, nil
}

func sameParent(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
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
