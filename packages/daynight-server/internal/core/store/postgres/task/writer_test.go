package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type recordingWriterTx struct {
	pgx.Tx
	arguments [][]any
	cause     error
}

func (tx *recordingWriterTx) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	tx.arguments = append(tx.arguments, args)
	if len(tx.arguments) == 2 {
		return pgconn.CommandTag{}, tx.cause
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

type failingRow struct{ err error }

func (r failingRow) Scan(...any) error { return r.err }
func (tx *recordingWriterTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	tx.arguments = append(tx.arguments, args)
	return failingRow{tx.cause}
}

func TestDeleteTaskRetainsProjectScopeAndError(t *testing.T) {
	cause := errors.New("delete failed")
	tx := &recordingWriterTx{cause: cause}
	_, err := NewWriter(tx, "project").DeleteTask(context.Background(), "task", true)
	if !errors.Is(err, cause) || len(tx.arguments) != 2 {
		t.Fatalf("delete returned %v after %d statements", err, len(tx.arguments))
	}
	for _, args := range tx.arguments {
		if len(args) < 2 || args[0] != "project" || args[1] != "task" {
			t.Fatalf("incorrect Project or Task scope: %v", args)
		}
	}
}

func TestInsertDependenciesPreservesClassificationAndStopsOnFailure(t *testing.T) {
	cause := &pgconn.PgError{Code: "23505", Message: "duplicate dependency"}
	tx := &recordingWriterTx{cause: cause}
	writer := &Writer{tx: tx, projectID: "project"}
	err := writer.insertDependencies(t.Context(), "task", []string{"ordinary", "external", "unattempted"}, []string{"external"})
	var failure *store.Error
	if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Phase != "insert dependency" {
		t.Fatalf("insertDependencies error = %v; want classified original failure", err)
	}
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != "23505" {
		t.Fatalf("database failure facts = %v, %q", failed, state)
	}
	if len(tx.arguments) != 2 {
		t.Fatalf("executed %d inserts; want stop at second dependency", len(tx.arguments))
	}
	for index, dependency := range []string{"ordinary", "external"} {
		args := tx.arguments[index]
		if len(args) != 4 || args[0] != "project" || args[1] != "task" || args[2] != dependency || args[3] != (index == 1) {
			t.Fatalf("dependency %d arguments = %v", index, args)
		}
	}
}
