package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

// TaskPresence preserves deletion information until the caller has authorized access.
type TaskPresence struct {
	Found     bool
	DeletedAt *time.Time
}

func taskPresence(ctx context.Context, tx pgx.Tx, projectID, taskID, lock string) (TaskPresence, error) {
	var presence TaskPresence
	err := tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2`+lock, projectID, taskID).Scan(&presence.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return presence, nil
	}
	if err != nil {
		return TaskPresence{}, queryError("read task presence", err)
	}
	presence.Found = true
	presence.DeletedAt = utcTime(presence.DeletedAt)
	return presence, nil
}

func (s *Snapshot) TaskPresence(ctx context.Context, projectID, taskID string) (TaskPresence, error) {
	return taskPresence(ctx, s.tx, projectID, taskID, "")
}

// ThreadCredential retains only the locked credential's expiry for final admission.
type ThreadCredential struct {
	ExpiresAt *time.Time
}

func threadCredential(ctx context.Context, tx pgx.Tx, principal core.Principal, lock string) (ThreadCredential, error) {
	table, err := credentialTable(principal.Kind)
	if err != nil {
		return ThreadCredential{}, queryError("read thread credential", err)
	}
	predicate := "expires_at > clock_timestamp()"
	if principal.Kind == core.PATCredential {
		predicate = "(expires_at IS NULL OR expires_at > clock_timestamp())"
	}
	var credential ThreadCredential
	err = tx.QueryRow(ctx, `SELECT expires_at FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+lock,
		principal.CredentialID, principal.UserID).Scan(&credential.ExpiresAt)
	if err != nil {
		return ThreadCredential{}, queryError("read thread credential", err)
	}
	credential.ExpiresAt = utcTime(credential.ExpiresAt)
	return credential, nil
}

func (s *Snapshot) Credential(ctx context.Context, principal core.Principal) (ThreadCredential, error) {
	return threadCredential(ctx, s.tx, principal, "")
}

const threadMessageProjection = `task_id::text,message_id::text,created_at,author_user_id::text,
 author_display_name,author_agent,author_claim_id::text,author_worker_id::text,author_provider,body,reply_to_message_id::text`

func scanThreadMessage(row pgx.Row) (core.ThreadMessage, error) {
	var message core.ThreadMessage
	var claimID, workerID, provider *string
	err := row.Scan(&message.TaskID, &message.ID, &message.CreatedAt, &message.Author.UserID,
		&message.Author.DisplayName, &message.Author.Agent, &claimID, &workerID, &provider, &message.Body, &message.ReplyTo)
	if err != nil {
		return core.ThreadMessage{}, err
	}
	if claimID != nil && workerID != nil && provider != nil {
		message.Author.Execution = &core.ThreadExecution{ClaimID: *claimID, WorkerID: *workerID, Provider: *provider}
	}
	message.CreatedAt = message.CreatedAt.UTC()
	return message, nil
}

func readThreadMessage(ctx context.Context, tx pgx.Tx, taskID, id string) (core.ThreadMessage, error) {
	message, err := scanThreadMessage(tx.QueryRow(ctx, `SELECT `+threadMessageProjection+`
 FROM task_thread_messages WHERE task_id=$1 AND message_id=$2`, taskID, id))
	if err != nil {
		return core.ThreadMessage{}, queryError("read thread message", err)
	}
	return message, nil
}

func (s *Snapshot) ThreadMessage(ctx context.Context, taskID, id string) (core.ThreadMessage, error) {
	return readThreadMessage(ctx, s.tx, taskID, id)
}

// ThreadCandidates returns at most limit candidates in traversal order and closes
// its rows before returning, so callers may query page sides on the same connection.
func (s *Snapshot) ThreadCandidates(ctx context.Context, taskID string, anchor *core.ThreadPosition, before bool, limit int) ([]core.ThreadMessage, error) {
	var anchorTime, anchorID any
	if anchor != nil {
		anchorTime, anchorID = anchor.CreatedAt, anchor.ID
	}
	comparison, order := ">", "ASC"
	if before {
		comparison, order = "<", "DESC"
	}
	rows, err := s.tx.Query(ctx, `SELECT `+threadMessageProjection+` FROM task_thread_messages
 WHERE task_id=$1 AND ($2::timestamptz IS NULL OR (created_at,message_id) `+comparison+` ($2,$3::uuid))
 ORDER BY created_at `+order+`,message_id `+order+` LIMIT $4`, taskID, anchorTime, anchorID, limit)
	if err != nil {
		return nil, queryError("read thread candidates", err)
	}
	defer rows.Close()
	items := make([]core.ThreadMessage, 0)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, queryError("read thread candidates", err)
		}
		message, err := scanThreadMessage(rows)
		if err != nil {
			return nil, queryError("read thread candidates", err)
		}
		items = append(items, message)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read thread candidates", err)
	}
	return items, nil
}

func (s *Snapshot) ThreadSides(ctx context.Context, taskID string, first, last core.ThreadPosition) (bool, bool, error) {
	var before, after bool
	err := s.tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM task_thread_messages WHERE task_id=$1 AND (created_at,message_id)<($2,$3::uuid)),
 EXISTS(SELECT 1 FROM task_thread_messages WHERE task_id=$1 AND (created_at,message_id)>($4,$5::uuid))`,
		taskID, first.CreatedAt, first.ID, last.CreatedAt, last.ID).Scan(&before, &after)
	if err != nil {
		return false, false, queryError("read thread page sides", err)
	}
	return before, after, nil
}
