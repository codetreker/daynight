package service

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func TestTeamInvitationLifecycle(t *testing.T) {
	_, db, _, admin := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	other := servicePrincipal(t, db)
	team := newTestTeam(t, teams, admin, " Team ")
	_, err := teams.CreateInvitation(ctx, admin, team.ID, other.UserID)
	teamFault(t, err, "identity_mismatch")
	minted, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if !validSecret(minted.Secret, teamInvitationPrefix) || minted.Invitation.TokenHash != nil || minted.Invitation.ExpiresAt.Sub(minted.Invitation.CreatedAt) != 7*24*time.Hour {
		t.Fatalf("mint: %#v", minted.Invitation)
	}
	var hash []byte
	if err = db.Pool.QueryRow(ctx, `SELECT token_hash FROM team_invitations WHERE id=$1`, minted.Invitation.ID).Scan(&hash); err != nil || !bytes.Equal(hash, secretHash(minted.Secret)) {
		t.Fatal("hash not persisted", err)
	}
	preview, err := teams.InspectInvitation(ctx, other, minted.Secret)
	if err != nil || preview.Team.ID != team.ID || preview.Team.Name == nil || *preview.Team.Name != " Team " || preview.Membership != nil {
		t.Fatalf("preview: %#v %v", preview, err)
	}
	existing, err := teams.AcceptInvitation(ctx, admin, minted.Secret, admin.UserID)
	if err != nil || existing.Joined || existing.Consumed || existing.Membership.Role != core.ProjectAdmin || existing.Membership.Version != team.Membership.Version {
		t.Fatalf("existing: %#v %v", existing, err)
	}
	active, err := teams.ListInvitations(ctx, admin, team.ID)
	if err != nil || len(active) != 1 || active[0].TokenHash != nil {
		t.Fatalf("list: %#v %v", active, err)
	}
	_, err = teams.AcceptInvitation(ctx, other, minted.Secret, admin.UserID)
	teamFault(t, err, "identity_mismatch")
	joined, err := teams.AcceptInvitation(ctx, other, minted.Secret, other.UserID)
	if err != nil || !joined.Joined || !joined.Consumed || joined.Membership.UserID != other.UserID || joined.Membership.Role != core.ProjectMemberRole {
		t.Fatalf("accept: %#v %v", joined, err)
	}
	_, err = teams.AcceptInvitation(ctx, admin, minted.Secret, admin.UserID)
	teamFault(t, err, "invitation_unavailable")
	_, err = teams.InspectInvitation(ctx, other, minted.Secret)
	teamFault(t, err, "invitation_unavailable")
	_, err = teams.CreateInvitation(ctx, other, team.ID, other.UserID)
	teamFault(t, err, "forbidden")
	pending, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := teams.RevokeInvitation(ctx, admin, team.ID, pending.Invitation.ID, admin.UserID)
	if err != nil || !changed {
		t.Fatalf("revoke %v %v", changed, err)
	}
	changed, err = teams.RevokeInvitation(ctx, admin, team.ID, pending.Invitation.ID, admin.UserID)
	if err != nil || changed {
		t.Fatalf("revoke no-op %v %v", changed, err)
	}
	_, err = teams.InspectInvitation(ctx, other, pending.Secret)
	teamFault(t, err, "invitation_unavailable")
	expired, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE team_invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1`, expired.Invitation.ID); err != nil {
		t.Fatal(err)
	}
	_, err = teams.AcceptInvitation(ctx, other, expired.Secret, other.UserID)
	teamFault(t, err, "invitation_unavailable")
	removable, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if err = teams.Delete(ctx, admin, team.ID, ChangeTeam{Name: *team.Name, Version: team.Version, ExpectedUserID: admin.UserID}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM team_invitations WHERE team_id=$1`, team.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("orphan invitations", count, err)
	}
	_, err = teams.InspectInvitation(ctx, other, removable.Secret)
	teamFault(t, err, "invitation_unavailable")
	page, err := teams.List(ctx, admin, PageRequest{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, personal := range page.Items {
		if personal.Kind == "personal" {
			_, err = teams.CreateInvitation(ctx, admin, personal.ID, admin.UserID)
			teamFault(t, err, "personal_team_immutable")
			_, err = teams.ListInvitations(ctx, admin, personal.ID)
			teamFault(t, err, "personal_team_immutable")
			_, err = teams.RevokeInvitation(ctx, admin, personal.ID, uuid.NewString(), admin.UserID)
			teamFault(t, err, "personal_team_immutable")
		}
	}
}

func TestTeamInvitationConcurrencyAndRollback(t *testing.T) {
	_, db, _, admin := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, admin, "Race")
	a, b := servicePrincipal(t, db), servicePrincipal(t, db)
	invitation, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for index, p := range []core.Principal{a, b} {
		wg.Add(1)
		go func(i int, p core.Principal) {
			defer wg.Done()
			_, errs[i] = teams.AcceptInvitation(ctx, p, invitation.Secret, p.UserID)
		}(index, p)
	}
	wg.Wait()
	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
		} else {
			teamFault(t, err, "invitation_unavailable")
		}
	}
	if wins != 1 {
		t.Fatalf("winners %d: %v", wins, errs)
	}
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND role='member'`, team.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	newcomer := servicePrincipal(t, db)
	retry, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `CREATE FUNCTION reject_team_invitation_consume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER reject_team_invitation_consume BEFORE UPDATE ON team_invitations FOR EACH ROW EXECUTE FUNCTION reject_team_invitation_consume()`); err != nil {
		t.Fatal(err)
	}
	_, err = teams.AcceptInvitation(ctx, newcomer, retry.Secret, newcomer.UserID)
	if err == nil {
		t.Fatal("failed consume succeeded")
	}
	preview, err := teams.InspectInvitation(ctx, newcomer, retry.Secret)
	if err != nil || preview.Membership != nil {
		t.Fatalf("rollback: %#v %v", preview, err)
	}
	if _, err = db.Pool.Exec(ctx, `DROP TRIGGER reject_team_invitation_consume ON team_invitations`); err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(ctx, newcomer, retry.Secret, newcomer.UserID); err != nil {
		t.Fatal(err)
	}
}

func TestTeamInvitationAcceptRevokeRace(t *testing.T) {
	_, db, _, admin := projectService(t)
	teams := NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, admin, "Race")
	member := servicePrincipal(t, db)
	i, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	var accepted error
	var changed bool
	var revokeErr error
	go func() { defer wg.Done(); _, accepted = teams.AcceptInvitation(ctx, member, i.Secret, member.UserID) }()
	go func() {
		defer wg.Done()
		changed, revokeErr = teams.RevokeInvitation(ctx, admin, team.ID, i.Invitation.ID, admin.UserID)
	}()
	wg.Wait()
	if revokeErr != nil {
		t.Fatal(revokeErr)
	}
	if accepted == nil && changed {
		t.Fatal("both consumed and revoked")
	}
	if accepted != nil {
		var fault *Fault
		if !errors.As(accepted, &fault) || fault.Code != "invitation_unavailable" || !changed {
			t.Fatalf("race: %v %v", accepted, changed)
		}
	}
}
