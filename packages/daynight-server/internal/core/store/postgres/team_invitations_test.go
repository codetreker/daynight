package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/jackc/pgx/v5"
)

func TestTeamInvitationStoreFailurePaths(t *testing.T) {
	s, admin, team := storeTeamFixture(t)
	ctx := context.Background()
	invitation := testutil.TeamInvitation(team, admin, "fault")
	if err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error { return tx.CreateInvitation(ctx, invitation) }); err != nil {
		t.Fatal(err)
	}
	// Unique hashes and member keys, and missing tables, must retain rollback evidence.
	assertRollback := func(err error) {
		t.Helper()
		var txErr *TransactionError
		if !errors.As(err, &txErr) || txErr.Outcome != TransactionNotCommitted {
			t.Fatalf("database failure lost rollback evidence: %v", err)
		}
	}
	for _, operation := range []func(TeamWriteDAO) error{
		func(tx TeamWriteDAO) error { return tx.CreateInvitation(ctx, invitation) },
		func(tx TeamWriteDAO) error { _, err := tx.AddInvitedMember(ctx, admin.UserID); return err },
	} {
		assertRollback(testWriteTeam(s, ctx, team.ID, operation))
	}
	for _, operation := range []func(TeamWriteDAO, pgx.Tx) error{
		func(tx TeamWriteDAO, raw pgx.Tx) error {
			if _, err := raw.Exec(ctx, `DROP TABLE team_invitations`); err != nil {
				return err
			}
			return tx.CreateInvitation(ctx, invitation)
		},
		func(tx TeamWriteDAO, raw pgx.Tx) error {
			if _, err := raw.Exec(ctx, `DROP TABLE team_invitations`); err != nil {
				return err
			}
			_, err := tx.RevokeInvitation(ctx, invitation.ID, time.Now())
			return err
		},
	} {
		assertRollback(testWriteTeamRaw(s, ctx, team.ID, operation))
	}

}
