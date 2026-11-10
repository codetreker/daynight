package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	t.Run("consume failure rolls back added membership", func(t *testing.T) {
		s, admin, team := storeTeamFixture(t)
		_, newcomer, _ := testAuthRecords(t, s)
		ctx := t.Context()
		invitation := testutil.TeamInvitation(team, admin, "consume failure")
		if err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error { return tx.CreateInvitation(ctx, invitation) }); err != nil {
			t.Fatal(err)
		}
		mustQueryExec(t, s, `CREATE FUNCTION refuse_team_invitation_consume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'consume failure'; END $$;
CREATE TRIGGER refuse_team_invitation_consume BEFORE UPDATE ON team_invitations FOR EACH ROW EXECUTE FUNCTION refuse_team_invitation_consume()`)
		consume := func(tx TeamWriteDAO) error {
			locked, err := tx.LockInvitation(ctx, invitation.TokenHash)
			if err != nil {
				return err
			}
			if _, err := tx.AddInvitedMember(ctx, newcomer.UserID); err != nil {
				return err
			}
			return tx.ConsumeInvitation(ctx, locked.ID, newcomer.UserID, time.Now())
		}
		err := testWriteTeam(s, ctx, team.ID, consume)
		var transaction *TransactionError
		var database *pgconn.PgError
		if !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted || transaction.CommitAttempted || !errors.As(err, &database) || database.Code != "P0001" || database.Message != "consume failure" {
			t.Fatalf("consume rollback lost SQL cause: %#v %v", transaction, err)
		}
		if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			current, err := snapshot.TeamDAO().TeamInvitation(ctx, invitation.TokenHash)
			if err != nil || current.ID != invitation.ID || current.ConsumedBy != nil || current.ConsumedAt != nil || current.RevokedAt != nil {
				return fmt.Errorf("failed consume changed invitation: %#v %v", current, err)
			}
			_, err = snapshot.TeamDAO().InvitationTeamMember(ctx, team.ID, newcomer.UserID)
			if !errors.Is(err, model.ErrNotFound) {
				return fmt.Errorf("failed consume retained partial member: %v", err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		mustQueryExec(t, s, `DROP TRIGGER refuse_team_invitation_consume ON team_invitations`)
		if err := testWriteTeam(s, ctx, team.ID, consume); err != nil {
			t.Fatalf("same token could not be reused after rollback: %v", err)
		}
		var consumer string
		var memberships int
		if err := s.Pool.QueryRow(ctx, `SELECT consumed_by::text,(SELECT count(*) FROM team_members WHERE team_id=$2 AND user_id=$3) FROM team_invitations WHERE id=$1 AND consumed_at IS NOT NULL`, invitation.ID, team.ID, newcomer.UserID).Scan(&consumer, &memberships); err != nil || consumer != newcomer.UserID || memberships != 1 {
			t.Fatalf("same-token retry did not persist atomically: %q %d %v", consumer, memberships, err)
		}
	})
	for _, change := range []string{"consumed", "revoked", "deleted"} {
		t.Run("lock waiter observes "+change, func(t *testing.T) {
			s, admin, team := storeTeamFixture(t)
			_, first, _ := testAuthRecords(t, s)
			_, second, _ := testAuthRecords(t, s)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			invitation := testutil.TeamInvitation(team, admin, change)
			if err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error { return tx.CreateInvitation(ctx, invitation) }); err != nil {
				t.Fatal(err)
			}
			at := time.Now().UTC().Truncate(time.Microsecond)
			var callback atomic.Bool
			done := make(chan error, 1)
			completion, err := s.WriteTeam(ctx, team.ID, func(scope TeamWriteScope) error {
				dao := scope.TeamDAO()
				switch change {
				case "consumed":
					if _, err := dao.AddInvitedMember(ctx, first.UserID); err != nil {
						return err
					}
					if err := dao.ConsumeInvitation(ctx, invitation.ID, first.UserID, at); err != nil {
						return err
					}
				case "revoked":
					changed, err := dao.RevokeInvitation(ctx, invitation.ID, at)
					if err != nil || !changed {
						return fmt.Errorf("initial revoke failed: %t %v", changed, err)
					}
				case "deleted":
					if err := dao.Delete(ctx); err != nil {
						return err
					}
				}
				go func() {
					_, err := s.WriteTeam(ctx, team.ID, func(waiter TeamWriteScope) error {
						callback.Store(true)
						current, err := waiter.TeamDAO().LockInvitation(ctx, invitation.TokenHash)
						if err != nil {
							return err
						}
						if change == "consumed" {
							if current.ConsumedBy == nil || *current.ConsumedBy != first.UserID || current.ConsumedAt == nil || !current.ConsumedAt.Equal(at) || current.RevokedAt != nil {
								return fmt.Errorf("waiter missed consumed invitation: %#v", current)
							}
							changed, err := waiter.TeamDAO().RevokeInvitation(ctx, current.ID, at)
							if err != nil || changed {
								return fmt.Errorf("consumed invitation was revoked: %t %v", changed, err)
							}
						} else if current.RevokedAt == nil || !current.RevokedAt.Equal(at) || current.ConsumedBy != nil || current.ConsumedAt != nil {
							return fmt.Errorf("waiter missed revoked invitation: %#v", current)
						}
						return nil
					})
					done <- err
				}()
				testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text FROM teams WHERE", scope.(teamWriteScope).tx.Conn().PgConn().PID())
				return nil
			})
			if err != nil || completion.Outcome != TransactionCommitted {
				t.Fatalf("first invitation mutation completion %#v %v", completion, err)
			}
			err = receiveQueryResult(t, ctx, done)
			if change == "deleted" {
				if !errors.Is(err, model.ErrNotFound) || callback.Load() {
					t.Fatalf("deleted Team invoked waiter callback: %t %v", callback.Load(), err)
				}
			} else if err != nil || !callback.Load() {
				t.Fatalf("waiter did not read current invitation: %t %v", callback.Load(), err)
			}
			var firstMemberships, secondMemberships int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE user_id=$2),count(*) FILTER(WHERE user_id=$3) FROM team_members WHERE team_id=$1`, team.ID, first.UserID, second.UserID).Scan(&firstMemberships, &secondMemberships); err != nil || firstMemberships != map[bool]int{false: 0, true: 1}[change == "consumed"] || secondMemberships != 0 {
				t.Fatalf("unique consumer directory: first=%d second=%d %v", firstMemberships, secondMemberships, err)
			}
			if change != "deleted" {
				var consumer *string
				var consumed, revoked *time.Time
				if err := s.Pool.QueryRow(ctx, `SELECT consumed_by::text,consumed_at,revoked_at FROM team_invitations WHERE id=$1`, invitation.ID).Scan(&consumer, &consumed, &revoked); err != nil {
					t.Fatal(err)
				}
				if change == "consumed" && (consumer == nil || *consumer != first.UserID || consumed == nil || !consumed.Equal(at) || revoked != nil) || change == "revoked" && (consumer != nil || consumed != nil || revoked == nil || !revoked.Equal(at)) {
					t.Fatalf("fresh invitation differs from locked row: %v %v %v", consumer, consumed, revoked)
				}
			}
		})
	}
}
