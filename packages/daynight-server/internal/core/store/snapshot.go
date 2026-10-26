package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

type Snapshot struct {
	tx pgx.Tx
}

func (s *Store) ReadSnapshot(ctx context.Context, operation func(*Snapshot) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return queryError("begin snapshot", err)
	}
	if err := transact(ctx, tx, func(tx pgx.Tx) error { return operation(&Snapshot{tx: tx}) }); err != nil {
		return queryError("snapshot", err)
	}
	return nil
}

func (s *Snapshot) Project(ctx context.Context, id string) (core.Project, error) {
	return readProject(ctx, s.tx, id)
}

func (s *Snapshot) Projects(ctx context.Context, page Page) (ProjectPage, error) {
	afterTime, afterID := pageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+projectProjection+` FROM projects
		WHERE ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2::uuid))
		ORDER BY created_at, id LIMIT $3`, afterTime, afterID, page.Limit+1)
	if err != nil {
		return ProjectPage{}, queryError("list projects", err)
	}
	defer rows.Close()
	items := make([]core.Project, 0)
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return ProjectPage{}, queryError("list projects", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return ProjectPage{}, queryError("list projects", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return ProjectPage{Items: items, HasMore: hasMore}, nil
}

func (s *Snapshot) Task(ctx context.Context, projectID, id string) (core.Task, error) {
	return readTask(ctx, s.tx, projectID, id)
}

func (s *Snapshot) Tasks(ctx context.Context, projectID string, query TaskQuery) (TaskPage, error) {
	afterTime, afterID := pageValues(query.Page)
	var limit any = query.Page.Limit + 1
	if query.Worker != nil {
		limit = nil
	}
	rows, err := s.tx.Query(ctx, `SELECT `+taskProjection+` FROM tasks t
		WHERE t.project_id = $1 AND t.deleted_at IS NULL
		AND ($2::timestamptz IS NULL OR (t.created_at, t.id) > ($2, $3::uuid))
		AND ($4::text IS NULL OR t.status = $4)
		AND ($5::boolean IS NULL OR `+taskReady+` = $5)
		AND ($6::boolean IS NULL OR t.allow_agents = $6)
		AND ($7::text IS NULL OR t.required_platform IS NULL OR t.required_platform = $7)
		ORDER BY t.created_at, t.id LIMIT $8`, projectID, afterTime, afterID, query.Status, query.Ready, query.AllowAgents, query.CompatiblePlatform, limit)
	if err != nil {
		return TaskPage{}, queryError("list tasks", err)
	}
	defer rows.Close()
	items := make([]core.Task, 0, query.Page.Limit+1)
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return TaskPage{}, queryError("list tasks", err)
		}
		// Worker ownership is decoded before the page limit so opaque PR strings
		// never pass through PostgreSQL JSON conversion or hide later matches.
		if query.Worker != nil {
			worker := task.Properties.Worker
			if worker == nil || worker.State != core.WorkerActive || worker.UserID != query.Worker.UserID || worker.WorkerID != query.Worker.WorkerID {
				continue
			}
		}
		items = append(items, task)
		if len(items) > query.Page.Limit {
			break
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return TaskPage{}, queryError("list tasks", err)
	}
	hasMore := len(items) > query.Page.Limit
	if hasMore {
		items = items[:query.Page.Limit]
	}
	return TaskPage{Items: items, HasMore: hasMore}, nil
}

func readTask(ctx context.Context, tx pgx.Tx, projectID, id string) (core.Task, error) {
	task, err := scanTask(liveTaskRow{tx.QueryRow(ctx, `SELECT `+taskProjection+`, t.deleted_at FROM tasks t
		WHERE t.project_id = $1 AND t.id = $2`, projectID, id)})
	if err != nil {
		return core.Task{}, queryError("read task", err)
	}
	return task, nil
}
