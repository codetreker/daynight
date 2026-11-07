package mcp

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const invitationTestTeamID = "00000000-0000-4000-8000-000000000001"
const invitationTestProjectID = "00000000-0000-4000-8000-000000000002"

type invitationTestTeams struct {
	minted               teamcore.MintedTeamInvitation
	page                 teamcore.InvitationPage
	inspection           teamcore.TeamInvitationInspection
	acceptance           teamcore.TeamInvitationAcceptance
	changed              bool
	err                  error
	calls                int
	lastID, lastExpected string
	request              model.PageRequest
}

func (s *invitationTestTeams) CreateInvitation(_ context.Context, p model.Principal, id, expected string) (teamcore.MintedTeamInvitation, error) {
	s.calls++
	s.lastID, s.lastExpected = id, expected
	return s.minted, s.err
}
func (s *invitationTestTeams) ListInvitationPage(_ context.Context, p model.Principal, id string, request model.PageRequest) (teamcore.InvitationPage, error) {
	s.calls++
	s.lastID, s.request = id, request
	return s.page, s.err
}
func (s *invitationTestTeams) RevokeInvitation(_ context.Context, p model.Principal, id, invitation, expected string) (bool, error) {
	s.calls++
	s.lastID, s.lastExpected = id, expected
	return s.changed, s.err
}
func (s *invitationTestTeams) InspectInvitation(_ context.Context, p model.Principal, secret string) (teamcore.TeamInvitationInspection, error) {
	s.calls++
	s.lastID = secret
	return s.inspection, s.err
}
func (s *invitationTestTeams) AcceptInvitation(_ context.Context, p model.Principal, secret, expected string) (teamcore.TeamInvitationAcceptance, error) {
	s.calls++
	s.lastID, s.lastExpected = secret, expected
	return s.acceptance, s.err
}

type invitationTestProjects struct {
	inspection               projectcore.InvitationInspection
	acceptance               projectcore.InvitationAcceptance
	err                      error
	calls                    int
	lastSecret, lastExpected string
}

func (s *invitationTestProjects) InspectInvitation(_ context.Context, p model.Principal, secret string) (projectcore.InvitationInspection, error) {
	s.calls++
	s.lastSecret = secret
	return s.inspection, s.err
}
func (s *invitationTestProjects) AcceptInvitation(_ context.Context, p model.Principal, secret, expected string) (projectcore.InvitationAcceptance, error) {
	s.calls++
	s.lastSecret, s.lastExpected = secret, expected
	return s.acceptance, s.err
}

func invitationCall(t *testing.T, client *sdk.ClientSession, name string, args any, wantError bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil || result.IsError != wantError {
		t.Fatalf("%s: tool error=%v transport error=%v", name, result != nil && result.IsError, err)
	}
	return structured(t, result)
}

func TestInvitationToolsAdaptServices(t *testing.T) {
	fixture := newEntryFixture(t)
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	teamSecret, projectSecret := "dnteam_"+strings.Repeat("A", 43), "dninvite_"+strings.Repeat("A", 43)
	name := "Team"
	member := model.TeamMember{TeamID: invitationTestTeamID, UserID: "alice", Role: model.ProjectAdmin, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
	grant := model.ProjectGrant{ProjectID: invitationTestProjectID, UserID: "alice", Role: model.ProjectAdmin, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
	access := model.ProjectAccess{ProjectID: invitationTestProjectID, Role: model.ProjectAdmin, DirectGrant: &grant, Ownership: model.ProjectOwnership{TeamID: invitationTestTeamID, Version: 7}, OwnerTeam: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}}
	team := &invitationTestTeams{
		minted:     teamcore.MintedTeamInvitation{Invitation: model.TeamInvitation{ID: invitationTestProjectID, TeamID: invitationTestTeamID, CreatedBy: "alice", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, Secret: teamSecret},
		inspection: teamcore.TeamInvitationInspection{Team: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}, Membership: &member},
		acceptance: teamcore.TeamInvitationAcceptance{Team: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}, Membership: member, Joined: true, Consumed: true}, changed: true,
	}
	project := &invitationTestProjects{inspection: projectcore.InvitationInspection{ProjectID: invitationTestProjectID, ProjectName: "Project", DirectGrant: &grant, Access: &access}, acceptance: projectcore.InvitationAcceptance{ProjectID: invitationTestProjectID, DirectGrant: grant, Access: access, Joined: true, Consumed: true}}
	if err := RegisterInvitationTools(fixture.entry, &identity.Identity{}, team, project, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	created := object(t, invitationCall(t, client, "team_invitation_create", map[string]any{"team": invitationTestTeamID, "confirm": true}, false)["data"])
	if created["link"] != "https://daynight.test/team-invitations#"+teamSecret || team.lastExpected != "alice" || team.lastID != invitationTestTeamID {
		t.Fatal("incorrect create receipt or actor")
	}
	teamLink := "https://daynight.test/team-invitations#" + teamSecret
	projectLink := "https://daynight.test/invitations#" + projectSecret
	for _, tc := range []struct{ scope, link string }{{"team", teamLink}, {"project", projectLink}} {
		out := invitationCall(t, client, "invitation_inspect", map[string]any{"link": tc.link}, false)
		data := object(t, out["data"])
		if data["scope"] != tc.scope {
			t.Fatalf("inspect scope: %#v", data)
		}
		if tc.scope == "team" {
			if object(t, data["membership"])["version"] != "9007199254740993" || team.lastID != teamSecret {
				t.Fatal("incorrect Team inspection")
			}
		} else if object(t, data["directGrant"])["version"] != "9007199254740993" || object(t, data["access"])["projectId"] != invitationTestProjectID || project.lastSecret != projectSecret {
			t.Fatal("incorrect Project inspection")
		}
		out = invitationCall(t, client, "invitation_accept", map[string]any{"link": tc.link, "confirm": true}, false)
		data = object(t, out["data"])
		if data["scope"] != tc.scope || data["joined"] != true || data["consumed"] != true || object(t, out["meta"])["outcome"] != "changed" {
			t.Fatalf("accept %s: %#v", tc.scope, data)
		}
	}
	if team.lastExpected != "alice" || project.lastExpected != "alice" {
		t.Fatal("acceptance actor was not authenticated user")
	}
	team.acceptance.Joined, team.acceptance.Consumed = false, false
	project.acceptance.Joined, project.acceptance.Consumed = false, false
	for _, link := range []string{teamLink, projectLink} {
		out := invitationCall(t, client, "invitation_accept", map[string]any{"link": link, "confirm": true}, false)
		if object(t, out["meta"])["outcome"] != "unchanged" {
			t.Fatal("existing member outcome was not unchanged")
		}
	}
	for _, changed := range []bool{true, false} {
		team.changed = changed
		out := invitationCall(t, client, "team_invitation_revoke", map[string]any{"team": invitationTestTeamID, "invitationId": invitationTestProjectID, "confirm": true}, false)
		data := object(t, out["data"])
		if data["changed"] != changed || data["teamId"] != invitationTestTeamID || data["invitationId"] != invitationTestProjectID {
			t.Fatal("incorrect revoke receipt")
		}
	}
	team.err = &model.Fault{Code: "forbidden", Message: "denied"}
	for _, call := range []struct {
		name string
		args map[string]any
	}{
		{"team_invitation_create", map[string]any{"team": invitationTestTeamID, "confirm": true}},
		{"team_invitation_list", map[string]any{"team": invitationTestTeamID}},
		{"team_invitation_revoke", map[string]any{"team": invitationTestTeamID, "invitationId": invitationTestProjectID, "confirm": true}},
		{"invitation_inspect", map[string]any{"link": teamLink}},
		{"invitation_accept", map[string]any{"link": teamLink, "confirm": true}},
	} {
		out := invitationCall(t, client, call.name, call.args, true)
		if object(t, out["error"])["code"] != "forbidden" {
			t.Fatalf("%s did not propagate denial", call.name)
		}
	}
	project.err = &model.Fault{Code: "invitation_unavailable", Message: "Invitation is unavailable."}
	for _, call := range []struct {
		name string
		args map[string]any
	}{{"invitation_inspect", map[string]any{"link": projectLink}}, {"invitation_accept", map[string]any{"link": projectLink, "confirm": true}}} {
		out := invitationCall(t, client, call.name, call.args, true)
		if object(t, out["error"])["code"] != "invitation_unavailable" {
			t.Fatalf("%s did not propagate refusal", call.name)
		}
	}
	calls := team.calls + project.calls
	for _, link := range []string{"https://other.test/team-invitations#" + teamSecret, "https://daynight.test/invitations#" + teamSecret, teamLink + "?extra", strings.Repeat("a", 4097)} {
		out := invitationCall(t, client, "invitation_inspect", map[string]any{"link": link}, true)
		if object(t, out["error"])["code"] != "invalid_input" {
			t.Fatal("bad link was not rejected")
		}
	}
	if team.calls+project.calls != calls {
		t.Fatal("invalid link reached service")
	}
}

func TestInvitationPageBudgetAndCursor(t *testing.T) {
	fixture := newEntryFixture(t)
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	team := &invitationTestTeams{}
	for i := 1; i <= 100; i++ {
		team.page.Items = append(team.page.Items, model.TeamInvitation{ID: fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i), TeamID: invitationTestTeamID, CreatedBy: invitationTestProjectID, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	}
	if err := RegisterInvitationTools(fixture.entry, &identity.Identity{}, team, &invitationTestProjects{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	out := invitationCall(t, client, "team_invitation_list", map[string]any{"team": invitationTestTeamID, "limit": 100}, false)
	page := object(t, out["data"])
	items := page["items"].([]any)
	if len(items) == 0 || len(items) >= 100 || team.request.Limit != 100 {
		t.Fatalf("expected bounded page, got %d", len(items))
	}
	cursor, ok := page["nextCursor"].(string)
	if !ok {
		t.Fatal("missing trimmed page cursor")
	}
	decoded, err := query.ListPage(model.PageRequest{Limit: 100, Cursor: &cursor}, query.ListScope{Kind: "team_invitations", UserID: "alice", ProjectID: invitationTestTeamID})
	if err != nil || decoded.After == nil || decoded.After.ID != object(t, items[len(items)-1])["id"] {
		t.Fatal("cursor does not point to last returned item")
	}
	team.page.Items = nil
	invitationCall(t, client, "team_invitation_list", map[string]any{"team": invitationTestTeamID}, false)
	if team.request.Limit != 50 {
		t.Fatal("default page limit was not applied")
	}
	team.page.Items = []model.TeamInvitation{{ID: invitationTestProjectID, TeamID: invitationTestTeamID, CreatedBy: strings.Repeat("x", 17000), CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}
	out = invitationCall(t, client, "team_invitation_list", map[string]any{"team": invitationTestTeamID}, true)
	if object(t, out["error"])["code"] != "resource_limit_exceeded" {
		t.Fatal("oversized item was not rejected")
	}
	adapter := invitationAdapter{teams: team}
	actor := RequestActor{Principal: model.Principal{UserID: "alice"}}
	for _, handler := range []func(context.Context, RequestActor, invitationInput) (ToolResult, error){adapter.create, adapter.list, adapter.revoke} {
		if _, err := handler(t.Context(), actor, invitationInput{Team: "bad"}); err == nil {
			t.Fatal("invalid Team ID accepted")
		}
	}
	if err := RegisterInvitationTools(fixture.entry, nil, team, &invitationTestProjects{}, "https://daynight.test"); err == nil {
		t.Fatal("missing identity accepted")
	}
	if _, _, err := adapter.parseLink("invalid"); err == nil {
		t.Fatal("invalid link accepted")
	}
}
