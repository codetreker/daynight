package project

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

type transferTx struct {
	pgx.Tx
	locked []string
}

func (tx *transferTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	id := args[0].(string)
	tx.locked = append(tx.locked, id)
	return transferRow(id)
}

type transferRow string

func (row transferRow) Scan(dest ...any) error {
	id := string(row)
	name := "Team " + id
	*dest[0].(*string) = id
	*dest[1].(**string) = &name
	*dest[2].(**string) = nil
	*dest[3].(*int64) = 1
	return nil
}

func TestTransferTeamsUseStableLockOrder(t *testing.T) {
	tx := &transferTx{}
	source, target, err := NewWriter(tx, "project").LockTransferTeams(context.Background(), "z", "a")
	if err != nil || len(tx.locked) != 2 || tx.locked[0] != "a" || tx.locked[1] != "z" {
		t.Fatalf("lock order = %v, error = %v", tx.locked, err)
	}
	if source.Ref.ID != "z" || target.Ref.ID != "a" {
		t.Fatalf("source = %v, target = %v", source.Ref.ID, target.Ref.ID)
	}
}
