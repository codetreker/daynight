package postgres

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

type projectDeletion struct {
	tx        pgx.Tx
	projectID string
}

type deletionSnapshot struct{ projectDeletion }
type deletionScope struct{ projectDeletion }

func (s *Store) ReadProjectDeletion(ctx context.Context, id string, operation func(store.ProjectDeletionSnapshot) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error {
		return operation(&deletionSnapshot{projectDeletion{tx: tx, projectID: id}})
	}, true)
}

func (s *Store) WriteProjectDeletion(ctx context.Context, id string, operation func(store.ProjectDeletionScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin project deletion", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&locked); err != nil {
			return pg.QueryError("lock project for deletion", err)
		}
		// Task rows are intentionally locked regardless of their deleted_at value.
		rows, err := tx.Query(ctx, `SELECT id FROM tasks WHERE project_id=$1 ORDER BY id FOR UPDATE`, id)
		if err != nil {
			return pg.QueryError("lock project tasks for deletion", err)
		}
		for rows.Next() {
			var taskID string
			if err = rows.Scan(&taskID); err != nil {
				break
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return pg.QueryError("lock project tasks for deletion", err)
		}
		return operation(&deletionScope{projectDeletion{tx: tx, projectID: id}})
	})
	return teamCompletion("project deletion", err)
}

func (s *deletionSnapshot) ProjectDAO() store.ProjectReader          { return project.NewReader(s.tx) }
func (s *deletionScope) ProjectDAO() store.ProjectDeletionDAO        { return &s.projectDeletion }
func (s *deletionScope) EligibilityDAO() store.WebhookEligibilityDAO { return eligibility.New(s.tx) }
func (s *deletionScope) SessionDAO() store.ProjectSessionRetirementDAO {
	return session.NewProjectRetirementDAO(s.tx, s.projectID)
}

func (d *projectDeletion) Authorization(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	return pg.LockProjectAuthorization(ctx, d.tx, principal.UserID, d.projectID)
}
func (d *projectDeletion) MarkDeleted(ctx context.Context) (bool, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE projects SET deleted_at=statement_timestamp(),updated_at=statement_timestamp(),task_cache_epoch=gen_random_uuid() WHERE id=$1 AND deleted_at IS NULL`, d.projectID)
	if err != nil {
		return false, pg.QueryError("mark project deleted", err)
	}
	return tag.RowsAffected() == 1, nil
}
func (s *deletionSnapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	err := s.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&observed)
	if err != nil {
		return time.Time{}, pg.QueryError("read deletion observation time", err)
	}
	return observed.UTC(), nil
}
func (s *deletionSnapshot) Summary(ctx context.Context) (store.ProjectDeletionSummary, error) {
	var out store.ProjectDeletionSummary
	err := s.tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE status NOT IN ('done', 'cancelled')),
        (SELECT count(*) FROM task_attachments a JOIN tasks at ON at.id=a.task_id AND at.project_id=a.project_id WHERE at.project_id=$1 AND at.deleted_at IS NULL)
        FROM tasks WHERE project_id=$1 AND deleted_at IS NULL`, s.projectID).Scan(&out.TaskCount, &out.UnfinishedTaskCount, &out.AttachmentCount)
	if err != nil {
		return out, pg.QueryError("read project deletion summary", err)
	}
	return out, nil
}

// VisitTaskWorkers includes claims retained by deleted Tasks.
func (s *deletionSnapshot) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	return s.projectDeletion.visitTaskWorkers(ctx, true, visit)
}

func (d *projectDeletion) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	return d.visitTaskWorkers(ctx, false, visit)
}

func (d *projectDeletion) visitTaskWorkers(ctx context.Context, includeTitle bool, visit func(store.ProjectDeletionWorker) error) error {
	title, extras, joins := "''::text", "NULL::text,NULL::timestamptz", ""
	if includeTitle {
		title, extras = "t.title", "pp.value,w.last_seen_at"
		joins = `LEFT JOIN task_properties pp ON pp.task_id=t.id AND pp.name='paused'
        LEFT JOIN workers w ON w.user_id=(wp.value::jsonb->>'userId')::uuid
          AND w.worker_id=(wp.value::jsonb->>'workerId')::uuid`
	}
	rows, err := d.tx.Query(ctx, `SELECT t.id::text,`+title+`,wp.value,`+extras+` FROM tasks t
        JOIN task_properties wp ON wp.task_id=t.id AND wp.name='worker' `+joins+`
        WHERE t.project_id=$1 ORDER BY t.id`, d.projectID)
	if err != nil {
		return pg.QueryError("read project worker claims", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item store.ProjectDeletionWorker
		var raw string
		var paused *string
		if err = rows.Scan(&item.TaskID, &item.Title, &raw, &paused, &item.LastSeenAt); err != nil {
			return pg.QueryError("read project worker claims", err)
		}
		item.Worker, err = taskproperty.Worker(model.TaskProperties{"worker": json.RawMessage(raw)})
		if err != nil {
			return pg.QueryError("decode project worker claim", err)
		}
		if paused != nil {
			if err = json.Unmarshal([]byte(*paused), &item.Paused); err != nil {
				return pg.QueryError("decode project paused property", err)
			}
		}
		if item.LastSeenAt != nil {
			seen := item.LastSeenAt.UTC()
			item.LastSeenAt = &seen
		}
		if err = visit(item); err != nil {
			return err
		}
	}
	if err = rows.Err(); err != nil {
		return pg.QueryError("read project worker claims", err)
	}
	return nil
}
