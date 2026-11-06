package task

import (
	"context"
	"errors"
	"testing"

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

func TestDeleteTaskRetainsProjectScopeAndError(t *testing.T) {
	cause := errors.New("delete failed")
	tx := &recordingWriterTx{cause: cause}
	err := NewWriter(tx, "project").DeleteTask(context.Background(), "task", true)
	if !errors.Is(err, cause) || len(tx.arguments) != 2 {
		t.Fatalf("delete returned %v after %d statements", err, len(tx.arguments))
	}
	for _, args := range tx.arguments {
		if len(args) < 2 || args[0] != "project" || args[1] != "task" {
			t.Fatalf("incorrect Project or Task scope: %v", args)
		}
	}
}
