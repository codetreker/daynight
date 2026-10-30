package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5"
)

type WorkerTx struct {
	tx pgx.Tx
}

type WorkerPage struct {
	Items   []core.WorkerSnapshot
	HasMore bool
}

func (s *Store) WriteWorker(ctx context.Context, operation func(*WorkerTx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return queryError("begin worker snapshot", err)
	}
	if err := transact(ctx, tx, func(tx pgx.Tx) error { return operation(&WorkerTx{tx: tx}) }); err != nil {
		return queryError("write worker snapshot", err)
	}
	return nil
}

func (w *WorkerTx) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := w.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, queryError("read worker clock", err)
	}
	return observed.UTC(), nil
}

func (w *WorkerTx) ReportTaskSnapshots(ctx context.Context, userID, workerID string, inventory core.WorkerTaskInventory) ([]core.WorkerObservedTask, error) {
	items := make([]core.WorkerObservedTask, 0, len(inventory.Claims))
	if len(inventory.Claims) == 0 {
		return items, nil
	}
	ids := make([]string, len(inventory.Claims))
	references := make(map[string]core.WorkerTaskReference, len(inventory.Claims))
	for index, reference := range inventory.Claims {
		ids[index] = reference.TaskID
		references[reference.TaskID] = reference
	}
	rows, err := w.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, t.title, t.status, worker_property.value, p.name
		FROM tasks t
		JOIN project_members m ON m.project_id=t.project_id AND m.user_id=$2
		JOIN projects p ON p.id=t.project_id
 LEFT JOIN task_properties worker_property ON worker_property.task_id=t.id AND worker_property.name='worker'
		WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, ids, userID)
	if err != nil {
		return nil, queryError("read reported task sources", err)
	}
	defer rows.Close()
	matched := make(map[string]core.WorkerObservedTask, len(inventory.Claims))
	for rows.Next() {
		var task core.WorkerObservedTask
		var properties *string
		if err := rows.Scan(&task.TaskID, &task.ProjectID, &task.Title, &task.Status, &properties, &task.ProjectName); err != nil {
			return nil, queryError("read reported task sources", err)
		}
		if !task.Status.Valid() {
			return nil, queryError("read reported task sources", fmt.Errorf("stored task status is invalid"))
		}
		if properties == nil {
			continue
		}
		value, err := taskproperties.NormalizeValue("worker", json.RawMessage(*properties), false)
		if err != nil {
			return nil, queryError("decode reported task source", err)
		}
		reference := references[task.TaskID]
		claim, err := taskproperties.Worker(core.TaskProperties{"worker": value})
		if err != nil {
			return nil, queryError("decode reported worker", err)
		}
		if task.ProjectID != reference.ProjectID || task.Status != core.TaskInProgress || claim == nil ||
			claim.State != core.WorkerActive || claim.UserID != userID || claim.WorkerID != workerID || claim.ClaimID != reference.ClaimID {
			continue
		}
		task.ClaimID, task.Phase, task.Agent = claim.ClaimID, claim.Phase, claim.Agent
		matched[task.TaskID] = task
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read reported task sources", err)
	}
	for _, reference := range inventory.Claims {
		if task, ok := matched[reference.TaskID]; ok {
			items = append(items, task)
		}
	}
	return items, nil
}

const workerSnapshotProjection = `user_id::text, worker_id::text, created_at, last_seen_at, telemetry, task_snapshot`

func (w *WorkerTx) UpsertWorker(ctx context.Context, snapshot core.WorkerSnapshot) (core.WorkerSnapshot, error) {
	telemetry, err := json.Marshal(snapshot.Telemetry)
	if err != nil {
		return core.WorkerSnapshot{}, queryError("encode worker telemetry", err)
	}
	tasks, err := json.Marshal(snapshot.TaskSnapshot)
	if err != nil {
		return core.WorkerSnapshot{}, queryError("encode worker task snapshot", err)
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
		return core.WorkerSnapshot{}, queryError("upsert worker snapshot", err)
	}
	return worker, nil
}

func scanWorkerSnapshot(row pgx.Row) (core.WorkerSnapshot, error) {
	var worker core.WorkerSnapshot
	var telemetry, tasks []byte
	if err := row.Scan(&worker.UserID, &worker.WorkerID, &worker.CreatedAt, &worker.LastReportedAt, &telemetry, &tasks); err != nil {
		return core.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(telemetry, &worker.Telemetry); err != nil {
		return core.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(tasks, &worker.TaskSnapshot); err != nil {
		return core.WorkerSnapshot{}, err
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
	items := make([]core.WorkerSnapshot, 0, page.Limit+1)
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

func (s *Snapshot) Worker(ctx context.Context, userID, workerID string, observedAt time.Time) (core.WorkerSnapshot, error) {
	worker, err := scanWorkerSnapshot(s.tx.QueryRow(ctx, `SELECT `+workerSnapshotProjection+` FROM workers
		WHERE user_id=$1 AND worker_id=$2 AND last_seen_at >= $3::timestamptz - interval '72 hours'`, userID, workerID, observedAt))
	if err != nil {
		return core.WorkerSnapshot{}, queryError("read worker snapshot", err)
	}
	items := []core.WorkerSnapshot{worker}
	if err := s.filterWorkerTasks(ctx, userID, items); err != nil {
		return core.WorkerSnapshot{}, err
	}
	return items[0], nil
}

func (s *Snapshot) filterWorkerTasks(ctx context.Context, userID string, workers []core.WorkerSnapshot) error {
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
		JOIN project_members m ON m.project_id=t.project_id AND m.user_id=$2
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
		tasks := make([]core.WorkerObservedTask, 0, len(workers[index].TaskSnapshot.Items))
		for _, task := range workers[index].TaskSnapshot.Items {
			if projectID, exists := visible[task.TaskID]; exists && projectID == task.ProjectID {
				tasks = append(tasks, task)
			}
		}
		workers[index].TaskSnapshot.Items = tasks
	}
	return nil
}
