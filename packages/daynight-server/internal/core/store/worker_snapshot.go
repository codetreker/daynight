package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/jackc/pgx/v5"
)

type workerTx struct {
	tx pgx.Tx
}

type WorkerPage struct {
	Items   []model.WorkerSnapshot
	HasMore bool
}

func (s *Store) WriteWorker(ctx context.Context, operation func(WorkerScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, queryError("begin worker snapshot", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(&workerTx{tx: tx}) })
	return teamCompletion("write worker snapshot", err)
}

func (w *workerTx) WorkerDAO() WorkerWriteDAO { return w }

func (w *workerTx) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := w.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, queryError("read worker clock", err)
	}
	return observed.UTC(), nil
}

func (w *workerTx) ReportTaskSnapshots(ctx context.Context, userID string, inventory model.WorkerTaskInventory) ([]WorkerTaskSource, error) {
	items := make([]WorkerTaskSource, 0, len(inventory.Claims))
	if len(inventory.Claims) == 0 {
		return items, nil
	}
	ids := make([]string, len(inventory.Claims))
	for index, reference := range inventory.Claims {
		ids[index] = reference.TaskID
	}
	rows, err := w.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, t.title, t.status, worker_property.value, p.name
		FROM tasks t
		JOIN (`+projectAccessRelation+`) a ON a.project_id=t.project_id AND a.user_id=$2
		JOIN projects p ON p.id=t.project_id
 LEFT JOIN task_properties worker_property ON worker_property.task_id=t.id AND worker_property.name='worker'
		WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, ids, userID)
	if err != nil {
		return nil, queryError("read reported task sources", err)
	}
	defer rows.Close()
	for rows.Next() {
		var source WorkerTaskSource
		var properties *string
		if err := rows.Scan(&source.Task.ID, &source.Task.ProjectID, &source.Task.Title, &source.Task.Status, &properties, &source.ProjectName); err != nil {
			return nil, queryError("read reported task sources", err)
		}
		if !source.Task.Status.Valid() {
			return nil, queryError("read reported task sources", fmt.Errorf("stored task status is invalid"))
		}
		if properties == nil {
			continue
		}
		value, err := taskproperties.NormalizeValue("worker", json.RawMessage(*properties))
		if err != nil {
			return nil, queryError("decode reported task source", err)
		}
		source.Task.Properties = model.TaskProperties{"worker": value}
		items = append(items, source)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read reported task sources", err)
	}
	return items, nil
}

const workerSnapshotProjection = `user_id::text, worker_id::text, created_at, last_seen_at, telemetry, task_snapshot`

func (w *workerTx) UpsertWorker(ctx context.Context, snapshot model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	telemetry, err := json.Marshal(snapshot.Telemetry)
	if err != nil {
		return model.WorkerSnapshot{}, queryError("encode worker telemetry", err)
	}
	tasks, err := json.Marshal(snapshot.TaskSnapshot)
	if err != nil {
		return model.WorkerSnapshot{}, queryError("encode worker task snapshot", err)
	}
	worker, err := scanWorkerSnapshot(w.tx.QueryRow(ctx, `INSERT INTO workers
		(user_id, worker_id, created_at, last_seen_at, telemetry, task_snapshot)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, worker_id) DO UPDATE SET
			last_seen_at=EXCLUDED.last_seen_at,
			telemetry=EXCLUDED.telemetry,
			task_snapshot=CASE
				WHEN EXCLUDED.task_snapshot->>'state'='unavailable' THEN
					CASE WHEN workers.task_snapshot->>'state' IN ('observed', 'stale')
						THEN jsonb_set(workers.task_snapshot, '{state}', '"stale"'::jsonb)
						ELSE workers.task_snapshot END
				ELSE EXCLUDED.task_snapshot END
		WHERE workers.last_seen_at<EXCLUDED.last_seen_at
		RETURNING `+workerSnapshotProjection, snapshot.UserID, snapshot.WorkerID, snapshot.CreatedAt, snapshot.LastReportedAt, telemetry, tasks))
	if errors.Is(err, pgx.ErrNoRows) {
		// A separate ReadCommitted statement can observe the conflicting row after
		// its transaction commits; a same-statement CTE fallback cannot.
		// https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED
		worker, err = scanWorkerSnapshot(w.tx.QueryRow(ctx, `SELECT `+workerSnapshotProjection+` FROM workers WHERE user_id=$1 AND worker_id=$2`, snapshot.UserID, snapshot.WorkerID))
	}
	if err != nil {
		return model.WorkerSnapshot{}, queryError("upsert worker snapshot", err)
	}
	return worker, nil
}

func scanWorkerSnapshot(row pgx.Row) (model.WorkerSnapshot, error) {
	var worker model.WorkerSnapshot
	var telemetry, tasks []byte
	if err := row.Scan(&worker.UserID, &worker.WorkerID, &worker.CreatedAt, &worker.LastReportedAt, &telemetry, &tasks); err != nil {
		return model.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(telemetry, &worker.Telemetry); err != nil {
		return model.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(tasks, &worker.TaskSnapshot); err != nil {
		return model.WorkerSnapshot{}, err
	}
	worker.CreatedAt, worker.LastReportedAt = worker.CreatedAt.UTC(), worker.LastReportedAt.UTC()
	worker.TaskSnapshot.ObservedAt = utcTime(worker.TaskSnapshot.ObservedAt)
	worker.TaskSnapshot.InventoryObservedAt = utcTime(worker.TaskSnapshot.InventoryObservedAt)
	return worker, nil
}

func (s *Snapshot) Workers(ctx context.Context, userID string, observedAt time.Time, page Page) (WorkerPage, error) {
	afterTime, afterID := pageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+workerSnapshotProjection+` FROM workers
		WHERE user_id=$1 AND last_seen_at >= $2::timestamptz - interval '72 hours'
		AND ($3::timestamptz IS NULL OR (created_at, worker_id)>($3, $4::uuid))
		ORDER BY workers.created_at, workers.worker_id LIMIT $5`, userID, observedAt, afterTime, afterID, page.Limit+1)
	if err != nil {
		return WorkerPage{}, queryError("list worker snapshots", err)
	}
	items := make([]model.WorkerSnapshot, 0, page.Limit+1)
	for rows.Next() {
		item, err := scanWorkerSnapshot(rows)
		if err != nil {
			rows.Close()
			return WorkerPage{}, queryError("list worker snapshots", err)
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return WorkerPage{}, queryError("list worker snapshots", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	if err := s.filterWorkerTasks(ctx, userID, items); err != nil {
		return WorkerPage{}, err
	}
	return WorkerPage{Items: items, HasMore: hasMore}, nil
}

func (s *Snapshot) Worker(ctx context.Context, userID, workerID string, observedAt time.Time) (model.WorkerSnapshot, error) {
	worker, err := scanWorkerSnapshot(s.tx.QueryRow(ctx, `SELECT `+workerSnapshotProjection+` FROM workers
		WHERE user_id=$1 AND worker_id=$2 AND last_seen_at >= $3::timestamptz - interval '72 hours'`, userID, workerID, observedAt))
	if err != nil {
		return model.WorkerSnapshot{}, queryError("read worker snapshot", err)
	}
	items := []model.WorkerSnapshot{worker}
	if err := s.filterWorkerTasks(ctx, userID, items); err != nil {
		return model.WorkerSnapshot{}, err
	}
	return items[0], nil
}

func (s *Snapshot) filterWorkerTasks(ctx context.Context, userID string, workers []model.WorkerSnapshot) error {
	ids := make([]string, 0)
	for _, worker := range workers {
		for _, task := range worker.TaskSnapshot.Items {
			ids = append(ids, task.TaskID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.tx.Query(ctx, `SELECT t.id::text, t.project_id::text FROM tasks t
		JOIN (`+projectAccessRelation+`) a ON a.project_id=t.project_id AND a.user_id=$2
		WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, ids, userID)
	if err != nil {
		return queryError("filter worker task visibility", err)
	}
	defer rows.Close()
	visible := make(map[string]string, len(ids))
	for rows.Next() {
		var taskID, projectID string
		if err := rows.Scan(&taskID, &projectID); err != nil {
			return queryError("filter worker task visibility", err)
		}
		visible[taskID] = projectID
	}
	if err := rows.Err(); err != nil {
		return queryError("filter worker task visibility", err)
	}
	for index := range workers {
		tasks := make([]model.WorkerObservedTask, 0, len(workers[index].TaskSnapshot.Items))
		for _, task := range workers[index].TaskSnapshot.Items {
			if projectID, exists := visible[task.TaskID]; exists && projectID == task.ProjectID {
				tasks = append(tasks, task)
			}
		}
		workers[index].TaskSnapshot.Items = tasks
	}
	return nil
}
