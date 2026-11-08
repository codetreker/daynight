package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
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

// WorkerSummaries streams only list fields and counts currently visible tasks in
// the same snapshot. Large telemetry and task bodies never leave PostgreSQL.
func (s *Reader) WorkerSummaries(ctx context.Context, userID string, observedAt time.Time, page store.Page, consume func(store.WorkerSummary) (bool, error)) error {
	afterTime, afterID := pg.PageValues(page)
	machineID := summaryText("w.telemetry", "machine", "id")
	machineName := summaryText("w.telemetry", "machine", "name")
	platform := summaryText("w.telemetry", "platform")
	state := summaryText("w.task_snapshot", "state")
	observed := `(` + summaryValue("w.task_snapshot", false, "observedAt") + `#>>'{}')`
	items := summaryValue("w.task_snapshot", false, "items")
	selectedItems := `CASE WHEN jsonb_typeof(` + items + `)='array' THEN ` + items + ` ELSE '[]'::jsonb END`
	taskID := summaryTaskText("w.task_snapshot", "candidate.position", "taskId")
	countTaskID := summaryTaskText("w.task_snapshot", "item.position", "taskId")
	countProjectID := summaryTaskText("w.task_snapshot", "item.position", "projectId")
	malformed := `(` + pg.JSONShapeError("w.telemetry", reflect.TypeOf(model.WorkerTelemetry{})) + ` OR ` + pg.JSONShapeError("w.task_snapshot", reflect.TypeOf(model.WorkerTaskObservation{})) + `)`
	oversized := `(octet_length(coalesce(` + machineID + `,''))::bigint + octet_length(coalesce(` + machineName + `,''))::bigint + octet_length(coalesce(` + platform + `,''))::bigint + octet_length(coalesce(` + state + `,''))::bigint > 8388608)`
	rows, err := s.tx.Query(ctx, `SELECT w.worker_id::text, w.created_at, w.last_seen_at,
        CASE WHEN `+oversized+` THEN '' ELSE coalesce(`+machineID+`,'') END,
        CASE WHEN `+oversized+` THEN '' ELSE coalesce(`+machineName+`,'') END,
        CASE WHEN `+oversized+` THEN '' ELSE coalesce(`+platform+`,'') END,
        CASE WHEN `+oversized+` THEN '' ELSE coalesce(`+state+`,'') END,
        `+pg.CompactJSONTime(observed)+`, `+oversized+`, `+malformed+`,
        EXISTS (SELECT 1 FROM generate_series(0,jsonb_array_length(`+selectedItems+`)-1) AS candidate(position)
                WHERE NOT pg_input_is_valid(coalesce(`+taskID+`,''),'uuid')),
        (SELECT count(*) FROM generate_series(0,jsonb_array_length(`+selectedItems+`)-1) AS item(position)
          JOIN tasks t ON t.id::text = `+countTaskID+` AND t.project_id::text = `+countProjectID+` AND t.deleted_at IS NULL
          WHERE EXISTS (SELECT 1 FROM (`+pg.ProjectAccessRelation+`) a WHERE a.project_id=t.project_id AND a.user_id=$1))
        FROM workers w
        WHERE w.user_id=$1 AND w.last_seen_at >= $2::timestamptz - interval '72 hours'
        AND ($3::timestamptz IS NULL OR (w.created_at,w.worker_id)>($3,$4::uuid))
        ORDER BY w.created_at,w.worker_id LIMIT $5`, userID, observedAt, afterTime, afterID, page.Limit+1)
	if err != nil {
		return pg.QueryError("list worker summaries", err)
	}
	defer rows.Close()
	rowCount := 0
	for rows.Next() {
		var item store.WorkerSummary
		var observed *string
		var count int
		var malformed, invalidTaskID bool
		if err := rows.Scan(&item.WorkerID, &item.CreatedAt, &item.LastReportedAt, &item.Machine.ID, &item.Machine.Name, &item.Platform, &item.TaskObservationState, &observed, &item.Oversized, &malformed, &invalidTaskID, &count); err != nil {
			return pg.QueryError("list worker summaries", err)
		}
		if malformed {
			return pg.QueryError("decode worker summary", fmt.Errorf("stored worker summary is malformed"))
		}

		item.CreatedAt, item.LastReportedAt = item.CreatedAt.UTC(), item.LastReportedAt.UTC()
		if observed != nil {
			value, err := time.Parse(time.RFC3339Nano, *observed)
			if err != nil {
				return pg.QueryError("decode worker observation time", err)
			}
			value = value.UTC()
			item.TaskObservedAt = &value
		}
		if item.TaskObservationState != model.WorkerTasksUnavailable {
			item.ActiveTaskCount = &count
		}
		// The original reader decoded and filtered every candidate within the
		// requested count, even if a later byte budget excludes that item. It
		// removed the count lookahead before filtering task IDs.
		if invalidTaskID && rowCount < page.Limit {
			return pg.QueryError("filter worker task visibility", fmt.Errorf("stored worker task ID is invalid"))
		}
		more, err := consume(item)
		if err != nil {
			return err
		}
		if !more {
			break
		}
		rowCount++
	}
	if err := rows.Err(); err != nil {
		return pg.QueryError("list worker summaries", err)
	}
	return nil
}

// summaryValue follows encoding/json's case-insensitive field matching and
// JSONB's field order. Struct strings ignore null; pointer and slice values do not.
func summaryValue(root string, stringsOnly bool, path ...string) string {
	var from, where, order []string
	parent := root
	for i, name := range path {
		alias := fmt.Sprintf("summary%d", i)
		source := `jsonb_object_keys(CASE WHEN jsonb_typeof(` + parent + `)='object' THEN ` + parent + ` ELSE '{}'::jsonb END) WITH ORDINALITY AS ` + alias + `(key,ord)`
		from = append(from, source)
		where = append(where, pg.JSONFold(alias+".key")+`='`+strings.ToLower(name)+`'`)
		order = append(order, alias+`.ord DESC`)
		parent = `(` + parent + `->` + alias + `.key)`
	}
	if stringsOnly {
		where = append(where, `jsonb_typeof(`+parent+`)='string'`)
	}
	return `(SELECT ` + parent + ` FROM ` + strings.Join(from, ` CROSS JOIN LATERAL `) + ` WHERE ` + strings.Join(where, ` AND `) + ` ORDER BY ` + strings.Join(order, `, `) + ` LIMIT 1)`
}
func summaryText(root string, path ...string) string {
	return `(` + summaryValue(root, true, path...) + `#>>'{}')`
}

// summaryTaskText follows slice reuse across differently cased Items keys. A
// null or empty array resets the slice; otherwise each object updates the
// existing element at its position, leaving absent or null string fields intact.
func summaryTaskText(root, position, field string) string {
	arr := `(` + root + `->aliases.key)`
	reset := `(SELECT coalesce(max(resets.ord),0) FROM jsonb_object_keys(` + root + `) WITH ORDINALITY AS resets(key,ord)
        WHERE ` + pg.JSONFold("resets.key") + `='items' AND (jsonb_typeof(` + root + `->resets.key)='null' OR CASE WHEN jsonb_typeof(` + root + `->resets.key)='array' THEN jsonb_array_length(` + root + `->resets.key)=0 ELSE false END))`
	value := summaryText(`(`+arr+`->`+position+`)`, field)
	return `(SELECT projected.value FROM jsonb_object_keys(` + root + `) WITH ORDINALITY AS aliases(key,ord)
        CROSS JOIN LATERAL (SELECT ` + value + ` AS value) projected
        WHERE ` + pg.JSONFold("aliases.key") + `='items' AND aliases.ord>` + reset + ` AND jsonb_typeof(` + arr + `)='array' AND projected.value IS NOT NULL
        ORDER BY aliases.ord DESC LIMIT 1)`
}
