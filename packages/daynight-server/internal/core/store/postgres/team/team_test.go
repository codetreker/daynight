package team

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

type teamRow func(...any) error

func (row teamRow) Scan(values ...any) error { return row(values...) }

func TestTeamScannersRejectInvalidShapeAndRetainCauses(t *testing.T) {
	cause := errors.New("Team scan failed")
	if _, err := scanTeam(teamRow(func(...any) error { return cause })); !errors.Is(err, cause) {
		t.Fatalf("scan cause: %v", err)
	}
	if _, _, err := scanBoundedTeam(teamRow(func(...any) error { return cause })); !errors.Is(err, cause) {
		t.Fatalf("bounded scan cause: %v", err)
	}
	for _, personal := range []bool{false, true} {
		row := teamRow(func(destinations ...any) error {
			if personal {
				owner := "owner"
				*destinations[1].(**string) = &owner
			}
			return nil
		})
		if _, err := scanTeam(row); err == nil {
			t.Fatalf("invalid personal=%v shape accepted", personal)
		}
		if _, _, err := scanBoundedTeam(row); err == nil {
			t.Fatalf("invalid bounded personal=%v shape accepted", personal)
		}
	}
}

func TestTeamWriteFailuresRetainCauses(t *testing.T) {
	cause := errors.New("Team write failed")
	for _, statement := range []int{1, 2} {
		tx := &recordingTx{failAt: statement, cause: cause}
		if _, err := NewCreation(tx, "owner").InsertTeam(context.Background(), "team", "Name"); !errors.Is(err, cause) {
			t.Fatalf("creation statement %d cause: %v", statement, err)
		}
	}
	tx := &recordingTx{failAt: 3, cause: cause}
	if err := NewWriter(tx, "team").Delete(context.Background()); !errors.Is(err, cause) || len(tx.arguments) != 3 {
		t.Fatalf("final delete cause: %v", err)
	}
	tx = &recordingTx{failAt: 2, cause: cause}
	if err := NewWriter(tx, "team").CreateInvitation(context.Background(), model.TeamInvitation{}); !errors.Is(err, cause) {
		t.Fatalf("invitation insertion cause: %v", err)
	}
}
