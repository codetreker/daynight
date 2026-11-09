package pg

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"testing"
)

type workerSnapshotRow func(...any) error

func (row workerSnapshotRow) Scan(values ...any) error { return row(values...) }

func TestWorkerSnapshotScannerPropagatesStoredDecodeErrors(t *testing.T) {
	want := errors.New("scan unavailable")
	if _, err := ScanWorkerSnapshot(workerSnapshotRow(func(...any) error { return want })); !errors.Is(err, want) {
		t.Fatalf("scan failure lost cause: %v", err)
	}
	for _, values := range []struct{ telemetry, tasks string }{{`{"cpu":"invalid"}`, `{}`}, {`{}`, `{"items":"invalid"}`}} {
		_, err := ScanWorkerSnapshot(workerSnapshotRow(func(destinations ...any) error {
			*destinations[4].(*[]byte) = []byte(values.telemetry)
			*destinations[5].(*[]byte) = []byte(values.tasks)
			return nil
		}))
		if err == nil {
			t.Fatal("stored invalid typed snapshot was silently accepted")
		}
	}
	if _, err := ScanWorkerSnapshot(workerSnapshotRow(func(...any) error { return pgx.ErrNoRows })); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("not-found scan changed cause: %v", err)
	}
}
