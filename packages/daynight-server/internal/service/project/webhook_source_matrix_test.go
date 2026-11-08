package project

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestWebhookSourceMatrixAndSharedCreatorIndependence(t *testing.T) {
	f := newMembershipFixture(t)
	ctx := context.Background()
	owner, creator := f.user(t), f.user(t)
	teams := teamservice.NewTeams(f.database)
	team := newTestTeam(t, teams, owner, "webhook matrix")
	p, err := f.projects.Create(ctx, owner, coreproject.CreateProject{ExpectedUserID: owner.UserID, Name: "matrix", RepoURL: "https://example.com/a/b", TeamID: &team.ID})
	if err != nil {
		t.Fatal(err)
	}
	inviteTeam := func() coreteam.TeamInvitationAcceptance {
		t.Helper()
		invitation, e := teams.CreateInvitation(ctx, owner, team.ID, owner.UserID)
		if e != nil {
			t.Fatal(e)
		}
		joined, e := teams.AcceptInvitation(ctx, creator, invitation.Secret, creator.UserID)
		if e != nil {
			t.Fatal(e)
		}
		return joined
	}
	joined := inviteTeam()
	promoted, err := teams.SetMemberRole(ctx, owner, team.ID, creator.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	svc := &webhookservice.Service{DB: f.database, ConfigurationExpansionAvailable: true}
	create := func(o webhookservice.Owner, enabled bool) (string, string) {
		t.Helper()
		name := "matrix"
		m := webhookservice.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: creator.UserID, RequestSHA256: string(bytes.Repeat([]byte{'a'}, 64)), Name: &name, Enabled: &enabled, Destination: &webhookservice.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: p.ID, EventTypes: []string{"task.created"}}}}
		result, e := svc.Mutate(ctx, creator, o, m)
		if e != nil {
			t.Fatal(e)
		}
		ep := result.Body.(map[string]any)["endpoint"].(map[string]any)
		sub := ep["subscriptions"].([]any)[0].(map[string]any)
		return ep["id"].(string), sub["id"].(string)
	}
	_, personal := create(webhookservice.Owner{Kind: "personal", ID: creator.UserID}, true)
	_, paused := create(webhookservice.Owner{Kind: "personal", ID: creator.UserID}, false)
	sharedEP, shared := create(webhookservice.Owner{Kind: "team", ID: team.ID}, true)
	assert := func(id, state string, epoch int64) {
		t.Helper()
		var got string
		var number int64
		if e := f.database.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&got, &number); e != nil {
			t.Fatal(e)
		}
		if got != state || number != epoch {
			t.Fatalf("subscription %s: %s %d; expected %s %d", id, got, number, state, epoch)
		}
	}
	assertAll := func(personalState string, epoch int64) {
		t.Helper()
		assert(personal, personalState, epoch)
		assert(paused, personalState, epoch)
		assert(shared, "active", 1)
	}
	demoted, err := teams.SetMemberRole(ctx, owner, team.ID, creator.UserID, coreteam.ChangeTeamMember{Version: promoted.Membership.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	assertAll("active", 1)
	grant, err := f.memberships.SetGrant(ctx, owner, p.ID, creator.UserID, coreproject.SetProjectGrant{Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	role, err := f.memberships.SetRole(ctx, owner, p.ID, creator.UserID, coreproject.SetProjectMemberRole{Version: grant.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	assertAll("active", 1)
	if _, err = teams.RemoveMemberBounded(ctx, owner, team.ID, creator.UserID, coreteam.ChangeTeamMember{Version: demoted.Membership.Version, ExpectedUserID: owner.UserID}, 1<<20); err != nil {
		t.Fatal(err)
	}
	assertAll("active", 1)
	view, err := svc.Get(ctx, owner, webhookservice.Owner{Kind: "team", ID: team.ID}, sharedEP)
	if err != nil {
		t.Fatal(err)
	}
	if !view.(map[string]any)["capabilities"].(map[string]any)["manage"].(bool) {
		t.Fatal("current Team admin cannot manage shared endpoint")
	}
	if _, err = f.memberships.RemoveGrant(ctx, owner, p.ID, creator.UserID, coreproject.RemoveProjectMember{Version: role.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	assertAll("confirmation_required", 2)
	projectInvite, err := f.memberships.CreateInvitation(ctx, owner, p.ID, owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := f.memberships.AcceptInvitation(ctx, creator, projectInvite.Secret, creator.UserID)
	if err != nil {
		t.Fatal(err)
	}
	assertAll("confirmation_required", 2)
	joined = inviteTeam()
	assertAll("confirmation_required", 2)
	promoted, err = teams.SetMemberRoleBounded(ctx, owner, team.ID, creator.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	assertAll("confirmation_required", 2)
	if _, err = teams.RemoveMember(ctx, owner, team.ID, creator.UserID, coreteam.ChangeTeamMember{Version: promoted.Membership.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	assertAll("confirmation_required", 2)
	if _, err = f.memberships.RemoveGrant(ctx, owner, p.ID, creator.UserID, coreproject.RemoveProjectMember{Version: accepted.DirectGrant.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	assertAll("confirmation_required", 2)
}
