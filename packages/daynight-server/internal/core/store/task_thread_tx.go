package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

const threadClockBudget = 100 * time.Millisecond

// ThreadClockError means the bounded preparation did not obtain a reliable
// forward position; it does not assert that the database clock moved backwards.
type ThreadClockError struct {
	Head     core.ThreadPosition
	Observed time.Time
	Cause    error
}

func (err *ThreadClockError) Error() string {
	return "reliable forward clock position was not obtained within budget"
}
func (err *ThreadClockError) Unwrap() error { return err.Cause }

func (tx *ThreadTx) LockTaskPresence(ctx context.Context, projectID, taskID string) (TaskPresence, error) {
	return taskPresence(ctx, tx.tx, projectID, taskID, " FOR SHARE")
}

func (tx *ThreadTx) Credential(ctx context.Context, principal core.Principal) (ThreadCredential, error) {
	return threadCredential(ctx, tx.tx, principal, " FOR SHARE")
}

func (tx *ThreadTx) AuthorName(ctx context.Context, userID string) (*string, error) {
	var name *string
	if err := tx.tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, userID).Scan(&name); err != nil {
		return nil, queryError("read thread author", err)
	}
	return name, nil
}

// SourceTask reads only source validation fields after the parent task is locked.
func (tx *ThreadTx) SourceTask(ctx context.Context, projectID, taskID string) (core.Task, error) {
	result := core.Task{ID: taskID, ProjectID: projectID, Properties: core.TaskProperties{}}
	var workerValue *string
	err := tx.tx.QueryRow(ctx, `SELECT t.status,p.value FROM tasks t
 LEFT JOIN task_properties p ON p.task_id=t.id AND p.name='worker'
 WHERE t.project_id=$1 AND t.id=$2`, projectID, taskID).Scan(&result.Status, &workerValue)
	if err != nil {
		return core.Task{}, queryError("read thread source", err)
	}
	if workerValue != nil {
		result.Properties["worker"], err = taskproperties.NormalizeValue("worker", json.RawMessage(*workerValue), false)
		if err != nil {
			return core.Task{}, queryError("decode thread source", err)
		}
	}
	return result, nil
}

// LockHead uses separate statements so a concurrent first append is visible in
// the second Read Committed snapshot after conflict-ignore waits for its commit.
func (tx *ThreadTx) LockHead(ctx context.Context, taskID string) (*core.ThreadPosition, error) {
	if _, err := tx.tx.Exec(ctx, `INSERT INTO task_threads(task_id) VALUES($1) ON CONFLICT DO NOTHING`, taskID); err != nil {
		return nil, queryError("initialize thread head", err)
	}
	var createdAt *time.Time
	var id *string
	if err := tx.tx.QueryRow(ctx, `SELECT last_created_at,last_message_id::text FROM task_threads WHERE task_id=$1 FOR UPDATE`, taskID).Scan(&createdAt, &id); err != nil {
		return nil, queryError("lock thread head", err)
	}
	if createdAt == nil {
		return nil, nil
	}
	return &core.ThreadPosition{CreatedAt: createdAt.UTC(), ID: *id}, nil
}

func (tx *ThreadTx) ThreadMessage(ctx context.Context, taskID, id string) (core.ThreadMessage, error) {
	return readThreadMessage(ctx, tx.tx, taskID, id)
}

// InsertMessage generates the UUID once in PostgreSQL. Only the uncommitted
// row's timestamp may subsequently be prepared to advance the locked head.
func (tx *ThreadTx) InsertMessage(ctx context.Context, message core.ThreadMessage) (core.ThreadMessage, error) {
	var claimID, workerID, provider any
	if source := message.Author.Execution; source != nil {
		claimID, workerID, provider = source.ClaimID, source.WorkerID, source.Provider
	}
	inserted, err := scanThreadMessage(tx.tx.QueryRow(ctx, `INSERT INTO task_thread_messages
 (task_id,created_at,author_user_id,author_display_name,author_agent,author_claim_id,author_worker_id,author_provider,body,reply_to_message_id)
 VALUES($1,date_trunc('milliseconds',clock_timestamp()),$2,$3,$4,$5,$6,$7,$8,$9)
 RETURNING `+threadMessageProjection, message.TaskID, message.Author.UserID, message.Author.DisplayName,
		message.Author.Agent, claimID, workerID, provider, message.Body, message.ReplyTo))
	if err != nil {
		return core.ThreadMessage{}, queryError("append thread message", err)
	}
	return inserted, nil
}

func threadPositionAfter(candidate, head core.ThreadPosition) bool {
	return candidate.CreatedAt.After(head.CreatedAt) ||
		(candidate.CreatedAt.Equal(head.CreatedAt) && strings.Compare(candidate.ID, head.ID) > 0)
}

// PrepareTimestamp advances an uncommitted candidate past the locked head using
// the actual database clock, retaining its UUID. It never manufactures head+1ms.
func (tx *ThreadTx) PrepareTimestamp(ctx context.Context, message *core.ThreadMessage, head *core.ThreadPosition) error {
	if head == nil || threadPositionAfter(message.Position(), *head) {
		return ctx.Err()
	}
	observed, err := forwardThreadClock(ctx, *head, threadClockBudget, func(ctx context.Context) (time.Time, error) {
		var observed time.Time
		err := tx.tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&observed)
		return observed.UTC(), err
	}, waitThreadClock)
	if err != nil {
		return err
	}
	if err := tx.tx.QueryRow(ctx, `UPDATE task_thread_messages SET created_at=$3
 WHERE task_id=$1 AND message_id=$2 RETURNING created_at`, message.TaskID, message.ID, observed).Scan(&message.CreatedAt); err != nil {
		return queryError("prepare thread timestamp", err)
	}
	message.CreatedAt = message.CreatedAt.UTC()
	if !threadPositionAfter(message.Position(), *head) {
		return queryError("prepare thread timestamp", errors.New("prepared thread position did not advance"))
	}
	return ctx.Err()
}

func forwardThreadClock(ctx context.Context, head core.ThreadPosition, budget time.Duration,
	sample func(context.Context) (time.Time, error), wait func(context.Context) error) (time.Time, error) {
	clock, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	var observed time.Time
	for {
		if err := ctx.Err(); err != nil {
			return time.Time{}, err
		}
		if err := clock.Err(); err != nil {
			return time.Time{}, &ThreadClockError{Head: head, Observed: observed, Cause: err}
		}
		value, err := sample(clock)
		if !value.IsZero() {
			observed = value.UTC()
		}
		if parentErr := ctx.Err(); parentErr != nil {
			return time.Time{}, parentErr
		}
		if err != nil {
			if clock.Err() != nil {
				return time.Time{}, &ThreadClockError{Head: head, Observed: observed, Cause: errors.Join(clock.Err(), err)}
			}
			return time.Time{}, queryError("sample thread clock", err)
		}
		if err := clock.Err(); err != nil {
			return time.Time{}, &ThreadClockError{Head: head, Observed: observed, Cause: err}
		}
		// Recovery waits for a later real millisecond even when the retained
		// UUID would sort after head at equal time. The initial fast path alone
		// accepts an already-forward candidate in the same millisecond.
		if observed.After(head.CreatedAt) {
			return observed, nil
		}
		if err := wait(clock); err != nil {
			if parentErr := ctx.Err(); parentErr != nil {
				return time.Time{}, parentErr
			}
			if clock.Err() != nil {
				return time.Time{}, &ThreadClockError{Head: head, Observed: observed, Cause: errors.Join(clock.Err(), err)}
			}
			return time.Time{}, err
		}
	}
}

func waitThreadClock(ctx context.Context) error {
	timer := time.NewTimer(time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// CredentialValid rechecks natural expiry after all waits. The credential row
// must remain share-locked until commit so revocation cannot pass this admission.
func (tx *ThreadTx) CredentialValid(ctx context.Context, credential ThreadCredential) (bool, error) {
	var valid bool
	err := tx.tx.QueryRow(ctx, `SELECT $1::timestamptz IS NULL OR $1 > clock_timestamp()`, credential.ExpiresAt).Scan(&valid)
	if err != nil {
		return false, queryError("recheck thread credential expiry", err)
	}
	return valid, nil
}

func (tx *ThreadTx) AdvanceHead(ctx context.Context, taskID string, position core.ThreadPosition) error {
	result, err := tx.tx.Exec(ctx, `UPDATE task_threads SET last_created_at=$2,last_message_id=$3
 WHERE task_id=$1 AND (last_created_at IS NULL OR (last_created_at,last_message_id)<($2,$3::uuid))`, taskID, position.CreatedAt, position.ID)
	if err != nil {
		return queryError("advance thread head", err)
	}
	if result.RowsAffected() != 1 {
		return queryError("advance thread head", errors.New("thread head did not advance"))
	}
	return nil
}
