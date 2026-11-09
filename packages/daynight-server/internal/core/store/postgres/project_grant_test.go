package postgres

import (
	"context"
	"errors"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func TestGrantCommitResponseLostKeepsUnknownAfterRealCommit(t *testing.T) {
	s, _, target, project := membershipFixture(t)
	ctx := context.Background()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, project.Ownership.TeamID, target.UserID); err != nil {
		t.Fatal(err)
	}
	transaction, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: transaction, cause: lost}, func(raw pgx.Tx) error {
		if _, err := raw.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
			return err
		}
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		if _, err := tx.ProjectDAO().ProjectAccess(ctx, target); err != nil {
			return err
		}
		_, err := tx.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectAdmin)
		return err
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "commit" || failure.Outcome != TransactionUnknown || !failure.CommitAttempted || failure.CleanupFailed || !errors.Is(err, lost) {
		t.Fatalf("lost receipt: %#v %v", failure, err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		member, err := snapshot.ProjectDAO().DirectProjectMember(ctx, target.UserID, project.ID)
		if err != nil {
			return err
		}
		if member.Grant.Role != model.ProjectAdmin || member.Grant.Version <= 0 {
			t.Fatalf("committed grant: %#v", member.Grant)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
