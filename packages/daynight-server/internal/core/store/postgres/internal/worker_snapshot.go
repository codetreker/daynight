package pg

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

const WorkerSnapshotProjection = `user_id::text, worker_id::text, created_at, last_seen_at, telemetry, task_snapshot`

const WorkerSnapshotAliasProjection = WorkerSnapshotProjection + `, alias_value, alias_version`

func ScanWorkerSnapshot(row pgx.Row) (model.WorkerSnapshot, error) {
	return scanWorkerSnapshot(row, false)
}

func ScanAliasedWorkerSnapshot(row pgx.Row) (model.WorkerSnapshot, error) {
	return scanWorkerSnapshot(row, true)
}

func scanWorkerSnapshot(row pgx.Row, alias bool) (model.WorkerSnapshot, error) {
	var worker model.WorkerSnapshot
	var telemetry, tasks []byte
	fields := []any{&worker.UserID, &worker.WorkerID, &worker.CreatedAt, &worker.LastReportedAt, &telemetry, &tasks}
	if alias {
		fields = append(fields, &worker.Alias.Value, &worker.Alias.Version)
	}
	if err := row.Scan(fields...); err != nil {
		return model.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(telemetry, &worker.Telemetry); err != nil {
		return model.WorkerSnapshot{}, err
	}
	if err := json.Unmarshal(tasks, &worker.TaskSnapshot); err != nil {
		return model.WorkerSnapshot{}, err
	}
	worker.CreatedAt, worker.LastReportedAt = worker.CreatedAt.UTC(), worker.LastReportedAt.UTC()
	worker.TaskSnapshot.ObservedAt = UTCTime(worker.TaskSnapshot.ObservedAt)
	worker.TaskSnapshot.InventoryObservedAt = UTCTime(worker.TaskSnapshot.InventoryObservedAt)
	return worker, nil
}
