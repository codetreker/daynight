package worker

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.WorkerMonitoringReader = (*Reader)(nil)

func (s *Reader) MonitoringWorkers(ctx context.Context, userID string, workerIDs []string, observedAt time.Time) ([]string, error) {
	ids := make([]string, 0, len(workerIDs))
	if len(workerIDs) == 0 {
		return ids, nil
	}
	rows, err := s.tx.Query(ctx, `SELECT worker_id::text FROM workers
		WHERE user_id=$1 AND worker_id=ANY($2::uuid[])
		AND last_seen_at >= $3::timestamptz - interval '72 hours'`, userID, workerIDs, observedAt)
	if err != nil {
		return nil, pg.QueryError("read monitoring workers", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.QueryError("read monitoring workers", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read monitoring workers", err)
	}
	return ids, nil
}

func (s *Reader) MonitoringSources(ctx context.Context, userID string, projectIDs, taskIDs []string) (store.WorkerMonitoringSources, error) {
	result := store.WorkerMonitoringSources{Projects: make(map[string]string), Tasks: make(map[string]store.WorkerTaskSource)}
	if len(projectIDs) > 0 {
		rows, err := s.tx.Query(ctx, `SELECT p.id::text, p.name FROM projects p
			JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$2
			WHERE p.id=ANY($1::uuid[])`, projectIDs, userID)
		if err != nil {
			return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring projects", err)
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring projects", err)
			}
			result.Projects[id] = name
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring projects", err)
		}
	}
	if len(taskIDs) > 0 {
		rows, err := s.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, t.title, t.status, wp.value, p.name
			FROM tasks t JOIN projects p ON p.id=t.project_id
			JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=t.project_id AND a.user_id=$2
			LEFT JOIN task_properties wp ON wp.task_id=t.id AND wp.name='worker'
			WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, taskIDs, userID)
		if err != nil {
			return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring tasks", err)
		}
		defer rows.Close()
		for rows.Next() {
			var source store.WorkerTaskSource
			var properties *string
			if err := rows.Scan(&source.Task.ID, &source.Task.ProjectID, &source.Task.Title, &source.Task.Status, &properties, &source.ProjectName); err != nil {
				return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring tasks", err)
			}
			if properties != nil {
				source.Task.Properties = model.TaskProperties{"worker": json.RawMessage(*properties)}
			}
			result.Tasks[source.Task.ID] = source
		}
		if err := rows.Err(); err != nil {
			return store.WorkerMonitoringSources{}, pg.QueryError("read monitoring tasks", err)
		}
	}
	return result, nil
}
