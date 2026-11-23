package migration114

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed lock.sql
var lockSQL string

//go:embed index.sql
var indexSQL string

//go:embed migrate.go
var migrationSource string

//go:embed worker.go
var workerSource string

//go:embed object.go
var objectSource string

type WorkerPropertyError struct {
	TaskID string
	Reason string
	cause  error
}

func (e *WorkerPropertyError) Error() string {
	return fmt.Sprintf("migration 114 task %s: %s", e.TaskID, e.Reason)
}

func (e *WorkerPropertyError) Unwrap() error { return e.cause }

func SQL() string { return lockSQL }

// TransformSource freezes the validator, original inventory decoder and DDL.
func TransformSource() string {
	return strings.ReplaceAll(strings.Join([]string{migrationSource, workerSource, objectSource, indexSQL}, "\x00"), "\r\n", "\n")
}

func Apply(ctx context.Context, tx pgx.Tx) error {
	var after *string
	for {
		rows, err := tx.Query(ctx, `SELECT task_id::text,value FROM task_properties
 WHERE name='worker' AND ($1::uuid IS NULL OR task_id>$1::uuid) ORDER BY task_id LIMIT 128`, after)
		if err != nil {
			return fmt.Errorf("migration 114 read worker properties: %w", err)
		}
		type record struct{ id, raw string }
		batch := make([]record, 0, 128)
		for rows.Next() {
			var item record
			if err := rows.Scan(&item.id, &item.raw); err != nil {
				rows.Close()
				return fmt.Errorf("migration 114 scan worker property: %w", err)
			}
			batch = append(batch, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("migration 114 read worker properties: %w", err)
		}
		if len(batch) == 0 {
			break
		}
		originals := make([]inventoryWorker, len(batch))
		extractions := &pgx.Batch{}
		for i, item := range batch {
			if err := validateWorker([]byte(item.raw)); err != nil {
				return &WorkerPropertyError{TaskID: item.id, Reason: "worker shape invalid", cause: err}
			}
			if err := json.Unmarshal([]byte(item.raw), &originals[i]); err != nil {
				return &WorkerPropertyError{TaskID: item.id, Reason: "original worker decode failed", cause: err}
			}
			extractions.Queue(`SELECT value::jsonb->>'state',value::jsonb->>'userId',value::jsonb->>'workerId'
 FROM task_properties WHERE task_id=$1::uuid AND name='worker'`, item.id)
		}
		results := tx.SendBatch(ctx, extractions)
		for i, item := range batch {
			var state, userID, workerID string
			if err := results.QueryRow().Scan(&state, &userID, &workerID); err != nil {
				return errors.Join(&WorkerPropertyError{TaskID: item.id, Reason: "PostgreSQL worker extraction failed", cause: err}, results.Close())
			}
			original := originals[i]
			if state != original.State || userID != original.UserID || workerID != original.WorkerID {
				return errors.Join(&WorkerPropertyError{TaskID: item.id, Reason: "worker extraction differs from original inventory decode"}, results.Close())
			}
		}
		if err := results.Close(); err != nil {
			return fmt.Errorf("migration 114 finish worker extraction batch: %w", err)
		}
		id := batch[len(batch)-1].id
		after = &id
	}
	if _, err := tx.Exec(ctx, indexSQL); err != nil {
		return fmt.Errorf("migration 114 create worker active claim index: %w", err)
	}
	return nil
}
