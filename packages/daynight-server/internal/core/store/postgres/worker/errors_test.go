package worker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type failedWorkerRows struct {
	pgx.Rows
	scan    func(...any) error
	failure error
	visited bool
}

func (rows *failedWorkerRows) Close() {}
func (rows *failedWorkerRows) Next() bool {
	if rows.visited || rows.scan == nil {
		return false
	}
	rows.visited = true
	return true
}
func (rows *failedWorkerRows) Scan(destinations ...any) error { return rows.scan(destinations...) }
func (rows *failedWorkerRows) Err() error                     { return rows.failure }

type workerFailureTx struct {
	pgx.Tx
	rows         pgx.Rows
	queryFailure error
	clockFailure error
	execFailure  error
}

func (tx workerFailureTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return tx.rows, tx.queryFailure
}
func (tx workerFailureTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return workerSnapshotRow(func(values ...any) error {
		if tx.clockFailure != nil {
			return tx.clockFailure
		}
		*values[0].(*time.Time) = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		return nil
	})
}
func (tx workerFailureTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, tx.execFailure
}

func TestWorkerSourceRowFailuresRemainVisible(t *testing.T) {
	cause := errors.New("worker source storage unavailable")
	inventory := model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{{TaskID: "task"}}}
	for _, test := range []struct {
		name string
		rows *failedWorkerRows
	}{
		{"scan", &failedWorkerRows{scan: func(...any) error { return cause }}},
		{"iteration", &failedWorkerRows{failure: cause}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewWriter(workerFailureTx{rows: test.rows}).ReportTaskSnapshots(t.Context(), "user", inventory)
			if !errors.Is(err, cause) {
				t.Fatalf("source cause lost: %v", err)
			}
		})
	}

}

func TestWorkerVisibilityAndListRowFailuresRemainVisible(t *testing.T) {
	cause := errors.New("worker visibility storage unavailable")
	workers := []model.WorkerSnapshot{{TaskSnapshot: model.WorkerTaskObservation{Items: []model.WorkerObservedTask{{TaskID: "task", ProjectID: "project"}}}}}
	for _, test := range []struct {
		name string
		tx   workerFailureTx
	}{
		{"query", workerFailureTx{queryFailure: cause}},
		{"scan", workerFailureTx{rows: &failedWorkerRows{scan: func(...any) error { return cause }}}},
		{"iteration", workerFailureTx{rows: &failedWorkerRows{failure: cause}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &Reader{tx: test.tx}
			if err := reader.filterWorkerTasks(t.Context(), "user", workers); !errors.Is(err, cause) {
				t.Fatalf("visibility cause lost: %v", err)
			}
		})
	}
	reader := &Reader{tx: workerFailureTx{rows: &failedWorkerRows{failure: cause}}}
	if _, err := reader.Workers(t.Context(), "user", time.Now(), store.Page{Limit: 1}); !errors.Is(err, cause) {
		t.Fatalf("list iteration cause lost: %v", err)
	}
}

func TestWorkerObservationUpdateFailurePreservesCause(t *testing.T) {
	cause := errors.New("observation update failed")
	writer := NewWriter(workerFailureTx{execFailure: cause})
	if err := writer.SetWorkerConfigurationObservation(t.Context(), "user", "worker", 1, model.WorkerConfigurationObservation{}); !errors.Is(err, cause) {
		t.Fatalf("update cause lost: %v", err)
	}
}

func TestWorkerSummariesPreserveFailures(t *testing.T) {
	cause := errors.New("worker summary failed")
	for _, tx := range []workerFailureTx{
		{queryFailure: cause},
		{rows: &failedWorkerRows{scan: func(...any) error { return cause }}},
		{rows: &failedWorkerRows{failure: cause}},
	} {
		_, err := (&Reader{tx: tx}).WorkerSummaries(t.Context(), "user", time.Now(), store.Page{Limit: 1})
		if !errors.Is(err, cause) {
			t.Fatalf("summary cause lost: %v", err)
		}
	}
}
