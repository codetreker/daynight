package team_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestTeamInvitationStoreLifecycle(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	admin, team := testutil.TeamFixture(t, s)
	ctx := context.Background()
	_, member, _ := testutil.AuthRecords(t, s)
	invitation := testutil.TeamInvitation(team, admin, "first")
	if err := testutil.WriteTeam(ctx, s, team.ID, func(tx TeamWriteDAO) error { return tx.CreateInvitation(ctx, invitation) }); err != nil {
		t.Fatal(err)
	}
	var personal string
	if err := s.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, admin.UserID).Scan(&personal); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		got, err := snapshot.TeamDAO().TeamInvitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		if got.ID != invitation.ID || got.TeamID != team.ID || got.ExpiresAt.Sub(got.CreatedAt) != 7*24*time.Hour {
			t.Fatal("invitation persistence")
		}
		list, err := snapshot.TeamDAO().TeamInvitations(ctx, team.ID, time.Now())
		if err != nil {
			return err
		}
		if len(list) != 1 || list[0].TokenHash != nil {
			t.Fatal("metadata exposed hash")
		}
		ordinary, err := snapshot.TeamDAO().InvitationTeam(ctx, team.ID)
		if err != nil {
			return err
		}
		if ordinary.Kind != "ordinary" || ordinary.Name == nil || *ordinary.Name != "Ordinary" {
			t.Fatal("ordinary Team reference")
		}
		ref, err := snapshot.TeamDAO().InvitationTeam(ctx, personal)
		if err != nil {
			return err
		}
		if ref.Kind != "personal" || ref.Name != nil {
			t.Fatal("personal Team reference")
		}
		_, err = snapshot.TeamDAO().InvitationTeam(ctx, uuid.NewString())
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team: %v", err)
		}
		_, err = snapshot.TeamDAO().InvitationTeamMember(ctx, team.ID, member.UserID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing member: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	lockedCtx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	holder, err := s.Pool.Begin(lockedCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(lockedCtx, `SELECT id FROM team_invitations WHERE id=$1 FOR UPDATE`, invitation.ID); err != nil {
		t.Fatal(err)
	}
	var current model.TeamInvitation
	done := make(chan error, 1)
	go func() {
		done <- testutil.WriteTeam(lockedCtx, s, team.ID, func(tx TeamWriteDAO) error {
			var err error
			current, err = tx.LockInvitation(lockedCtx, invitation.TokenHash)
			return err
		})
	}()
	testutil.WaitTransferTeamLock(t, lockedCtx, s.Pool, "SELECT id::text,team_id::text,created_by::text,token_hash", holder.Conn().PgConn().PID())
	expires := time.Now().UTC().Truncate(time.Microsecond).Add(500 * time.Millisecond)
	if _, err := holder.Exec(lockedCtx, `UPDATE team_invitations SET expires_at=$2 WHERE id=$1`, invitation.ID, expires); err != nil {
		t.Fatal(err)
	}
	if err := holder.Commit(lockedCtx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, lockedCtx, done); err != nil {
		t.Fatal(err)
	}
	if current.ID != invitation.ID || !current.ExpiresAt.Equal(expires) || current.ExpiresAt.Equal(invitation.ExpiresAt) {
		t.Fatalf("invitation lock returned expiry from before the lock wait: %#v", current)
	}
	var persistedExpiry time.Time
	if err := s.Pool.QueryRow(lockedCtx, `SELECT expires_at FROM team_invitations WHERE id=$1`, invitation.ID).Scan(&persistedExpiry); err != nil || !persistedExpiry.Equal(expires) {
		t.Fatalf("locked expiry differs from fresh row: %v %v", persistedExpiry, err)
	}
	if err := testutil.WriteTeam(ctx, s, team.ID, func(tx TeamWriteDAO) error {
		ref, err := tx.InvitationTeam(ctx)
		if err != nil || ref.ID != team.ID {
			return errors.New("locked Team reference")
		}
		got, err := tx.LockInvitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		joined, err := tx.AddMember(ctx, member.UserID, model.ProjectMemberRole)
		if err != nil {
			return err
		}
		if joined.UserID != member.UserID || joined.TeamID != team.ID || joined.Role != model.ProjectMemberRole || joined.Version < 1 {
			t.Fatal("invited member")
		}
		if err := tx.ConsumeInvitation(ctx, got.ID, member.UserID, time.Now()); err != nil {
			return err
		}
		changed, err := tx.RevokeInvitation(ctx, got.ID, time.Now())
		if err != nil || changed {
			return errors.New("consumed invitation was revoked")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var consumedBy string
	var acceptedMemberships int
	if err := s.Pool.QueryRow(ctx, `SELECT consumed_by::text,
		(SELECT count(*) FROM team_members WHERE team_id=$2 AND user_id=$3)
		FROM team_invitations WHERE id=$1`, invitation.ID, team.ID, member.UserID).Scan(&consumedBy, &acceptedMemberships); err != nil || consumedBy != member.UserID || acceptedMemberships != 1 {
		t.Fatalf("committed Team invitation actor and unique membership: %q %d %v", consumedBy, acceptedMemberships, err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		memberRow, err := snapshot.TeamDAO().InvitationTeamMember(ctx, team.ID, member.UserID)
		if err != nil || memberRow.Role != model.ProjectMemberRole {
			return errors.New("stored member")
		}
		list, err := snapshot.TeamDAO().TeamInvitations(ctx, team.ID, time.Now())
		if err != nil {
			return err
		}
		if len(list) != 0 {
			t.Fatal("consumed invitation listed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	revoked := testutil.TeamInvitation(team, admin, "second")
	if err := testutil.WriteTeam(ctx, s, team.ID, func(tx TeamWriteDAO) error {
		if err := tx.CreateInvitation(ctx, revoked); err != nil {
			return err
		}
		changed, err := tx.RevokeInvitation(ctx, revoked.ID, time.Now())
		if err != nil || !changed {
			return errors.New("revoke failed")
		}
		changed, err = tx.RevokeInvitation(ctx, revoked.ID, time.Now())
		if err != nil || changed {
			return errors.New("revoke no-op failed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := testutil.WriteTeam(ctx, s, team.ID, func(tx TeamWriteDAO) error { return tx.Delete(ctx) }); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM team_invitations WHERE team_id=$1`, team.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deletion left invitations", count, err)
	}
}

func TestTeamInvitationListFailureIsNotEmpty(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	_, team := testutil.TeamFixture(t, s)
	ctx := t.Context()
	if _, err := s.Pool.Exec(ctx, `DROP TABLE team_invitations`); err != nil {
		t.Fatal(err)
	}
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TeamDAO().TeamInvitations(ctx, team.ID, time.Now())
		return err
	})
	if err == nil {
		t.Fatal("list silently ignored missing table")
	}
}
