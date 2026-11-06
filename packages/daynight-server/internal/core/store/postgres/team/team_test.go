package team

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type recordingTx struct {
	pgx.Tx
	arguments [][]any
	failAt    int
	cause     error
}

func (tx *recordingTx) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	tx.arguments = append(tx.arguments, args)
	if len(tx.arguments) == tx.failAt {
		return pgconn.CommandTag{}, tx.cause
	}
	return pgconn.CommandTag{}, nil
}

func TestDeleteStopsOnFailureInBoundTransaction(t *testing.T) {
	cause := errors.New("members delete failed")
	tx := &recordingTx{failAt: 2, cause: cause}
	err := NewWriter(tx, "team-id").Delete(context.Background())
	if !errors.Is(err, cause) || len(tx.arguments) != 2 {
		t.Fatalf("delete returned %v after %d statements", err, len(tx.arguments))
	}
	for _, args := range tx.arguments {
		if len(args) != 1 || args[0] != "team-id" {
			t.Fatalf("incorrect Team scope: %v", args)
		}
	}
}
