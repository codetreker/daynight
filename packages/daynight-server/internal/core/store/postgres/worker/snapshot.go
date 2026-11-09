package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/jackc/pgx/v5"
)

// Reader and Writer bind Worker operations to their enclosing transaction.
type Reader struct{ tx pgx.Tx }
type Writer struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.WorkerReader { return &Reader{tx: tx} }
func NewWriter(tx pgx.Tx) *Writer            { return &Writer{tx: tx} }

var _ store.WorkerReader = (*Reader)(nil)
var _ store.WorkerScope = (*Writer)(nil)
var _ store.WorkerWriteDAO = (*Writer)(nil)

func (w *Writer) WorkerDAO() store.WorkerWriteDAO { return w }

func (w *Writer) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := w.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, pg.QueryError("read worker clock", err)
	}
	return observed.UTC(), nil
}

func (w *Writer) AdmitWorker(ctx context.Context, userID, workerID string, window time.Duration) (store.WorkerAdmission, error) {
	var result store.WorkerAdmission
	if _, err := w.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:' || $1::uuid::text, 0))`, userID); err != nil {
		return result, pg.QueryError("lock worker admission", err)
	}
	observed, err := w.ObservedAt(ctx)
	if err != nil {
		return result, err
	}
	result.ObservedAt = observed
	err = w.tx.QueryRow(ctx, `SELECT
		(SELECT last_seen_at FROM workers WHERE user_id=$1 AND worker_id=$2),
		(SELECT count(*) FROM workers WHERE user_id=$1 AND last_seen_at > $3::timestamptz - ($4::double precision * interval '1 second') AND last_seen_at <= $3)`,
		userID, workerID, observed, window.Seconds()).Scan(&result.LastSeenAt, &result.ActiveCount)
	if err != nil {
		return store.WorkerAdmission{}, pg.QueryError("read worker admission", err)
	}
	return result, nil
}

func (w *Writer) ReportTaskSnapshots(ctx context.Context, userID string, inventory model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	items := make([]store.WorkerTaskSource, 0, len(inventory.Claims))
	if len(inventory.Claims) == 0 {
		return items, nil
	}
	ids := make([]string, len(inventory.Claims))
	for index, reference := range inventory.Claims {
		ids[index] = reference.TaskID
	}
	rows, err := w.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, t.title, t.status, worker_property.value, p.name
		FROM tasks t
		JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=t.project_id AND a.user_id=$2
		JOIN projects p ON p.id=t.project_id
 LEFT JOIN task_properties worker_property ON worker_property.task_id=t.id AND worker_property.name='worker'
		WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, ids, userID)
	if err != nil {
		return nil, pg.QueryError("read reported task sources", err)
	}
	defer rows.Close()
	for rows.Next() {
		var source store.WorkerTaskSource
		var properties *string
		if err := rows.Scan(&source.Task.ID, &source.Task.ProjectID, &source.Task.Title, &source.Task.Status, &properties, &source.ProjectName); err != nil {
			return nil, pg.QueryError("read reported task sources", err)
		}
		if !source.Task.Status.Valid() {
			return nil, pg.QueryError("read reported task sources", fmt.Errorf("stored task status is invalid"))
		}
		if properties == nil {
			continue
		}
		value, err := taskproperties.NormalizeValue("worker", json.RawMessage(*properties))
		if err != nil {
			return nil, pg.QueryError("decode reported task source", err)
		}
		source.Task.Properties = model.TaskProperties{"worker": value}
		items = append(items, source)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read reported task sources", err)
	}
	return items, nil
}

func (w *Writer) UpsertWorker(ctx context.Context, snapshot model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	telemetry, err := json.Marshal(snapshot.Telemetry)
	if err != nil {
		return model.WorkerSnapshot{}, pg.QueryError("encode worker telemetry", err)
	}
	tasks, err := json.Marshal(snapshot.TaskSnapshot)
	if err != nil {
		return model.WorkerSnapshot{}, pg.QueryError("encode worker task snapshot", err)
	}
	worker, err := pg.ScanWorkerSnapshot(w.tx.QueryRow(ctx, `INSERT INTO workers
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
		RETURNING `+pg.WorkerSnapshotProjection, snapshot.UserID, snapshot.WorkerID, snapshot.CreatedAt, snapshot.LastReportedAt, telemetry, tasks))
	if err != nil {
		return model.WorkerSnapshot{}, pg.QueryError("upsert worker snapshot", err)
	}
	return worker, nil
}

func (s *Reader) Workers(ctx context.Context, userID string, observedAt time.Time, page store.Page) (store.WorkerPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+pg.WorkerSnapshotProjection+` FROM workers
		WHERE user_id=$1 AND last_seen_at >= $2::timestamptz - interval '72 hours'
		AND ($3::timestamptz IS NULL OR (created_at, worker_id)>($3, $4::uuid))
		ORDER BY workers.created_at, workers.worker_id LIMIT $5`, userID, observedAt, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.WorkerPage{}, pg.QueryError("list worker snapshots", err)
	}
	items := make([]model.WorkerSnapshot, 0, page.Limit+1)
	for rows.Next() {
		item, err := pg.ScanWorkerSnapshot(rows)
		if err != nil {
			rows.Close()
			return store.WorkerPage{}, pg.QueryError("list worker snapshots", err)
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return store.WorkerPage{}, pg.QueryError("list worker snapshots", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	if err := s.filterWorkerTasks(ctx, userID, items); err != nil {
		return store.WorkerPage{}, err
	}
	return store.WorkerPage{Items: items, HasMore: hasMore}, nil
}

func (s *Reader) Worker(ctx context.Context, userID, workerID string, observedAt time.Time) (model.WorkerSnapshot, error) {
	worker, err := pg.ScanWorkerSnapshot(s.tx.QueryRow(ctx, `SELECT `+pg.WorkerSnapshotProjection+` FROM workers
		WHERE user_id=$1 AND worker_id=$2 AND last_seen_at >= $3::timestamptz - interval '72 hours'`, userID, workerID, observedAt))
	if err != nil {
		return model.WorkerSnapshot{}, pg.QueryError("read worker snapshot", err)
	}
	items := []model.WorkerSnapshot{worker}
	if err := s.filterWorkerTasks(ctx, userID, items); err != nil {
		return model.WorkerSnapshot{}, err
	}
	return items[0], nil
}

func (s *Reader) filterWorkerTasks(ctx context.Context, userID string, workers []model.WorkerSnapshot) error {
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
		JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=t.project_id AND a.user_id=$2
		WHERE t.id=ANY($1::uuid[]) AND t.deleted_at IS NULL`, ids, userID)
	if err != nil {
		return pg.QueryError("filter worker task visibility", err)
	}
	defer rows.Close()
	visible := make(map[string]string, len(ids))
	for rows.Next() {
		var taskID, projectID string
		if err := rows.Scan(&taskID, &projectID); err != nil {
			return pg.QueryError("filter worker task visibility", err)
		}
		visible[taskID] = projectID
	}
	if err := rows.Err(); err != nil {
		return pg.QueryError("filter worker task visibility", err)
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

// WorkerSummaries selects list fields and counts currently visible tasks in the
// same snapshot without loading the complete telemetry or task snapshots.
func (s *Reader) WorkerSummaries(ctx context.Context, userID string, observedAt time.Time, page store.Page) (store.WorkerSummaryPage, error) {
	afterTime, afterID := pg.PageValues(page)
	// WorkerMachine persists its untagged ID and Name fields with their Go names.
	rows, err := s.tx.Query(ctx, `SELECT w.worker_id::text, w.created_at, w.last_seen_at,
        w.telemetry->'machine'->>'ID', w.telemetry->'machine'->>'Name', w.telemetry->>'platform',
        w.task_snapshot->>'state', w.task_snapshot->'observedAt' AS task_observed_at,
        (SELECT count(*) FROM jsonb_array_elements(w.task_snapshot->'items') item
          JOIN tasks t ON t.id=(item->>'taskId')::uuid AND t.project_id=(item->>'projectId')::uuid AND t.deleted_at IS NULL
          WHERE EXISTS (SELECT 1 FROM (`+pg.ProjectAccessRelation+`) a WHERE a.project_id=t.project_id AND a.user_id=$1))
        FROM workers w
        WHERE w.user_id=$1 AND w.last_seen_at >= $2::timestamptz - interval '72 hours'
        AND ($3::timestamptz IS NULL OR (w.created_at,w.worker_id)>($3,$4::uuid))
        ORDER BY w.created_at,w.worker_id LIMIT $5`, userID, observedAt, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.WorkerSummaryPage{}, pg.QueryError("list worker summaries", err)
	}
	defer rows.Close()
	items := make([]store.WorkerSummary, 0, page.Limit+1)
	for rows.Next() {
		var item store.WorkerSummary
		var count int
		if err := rows.Scan(&item.WorkerID, &item.CreatedAt, &item.LastReportedAt, &item.Machine.ID, &item.Machine.Name, &item.Platform, &item.TaskObservationState, &item.TaskObservedAt, &count); err != nil {
			return store.WorkerSummaryPage{}, pg.QueryError("list worker summaries", err)
		}
		item.CreatedAt, item.LastReportedAt = item.CreatedAt.UTC(), item.LastReportedAt.UTC()
		if item.TaskObservedAt != nil {
			observed := item.TaskObservedAt.UTC()
			item.TaskObservedAt = &observed
		}
		if item.TaskObservationState != model.WorkerTasksUnavailable {
			item.ActiveTaskCount = &count
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return store.WorkerSummaryPage{}, pg.QueryError("list worker summaries", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return store.WorkerSummaryPage{Items: items, HasMore: hasMore}, nil
}
