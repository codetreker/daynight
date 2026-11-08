package server

import (
	"net/http"
	"net/url"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTeamSelfExitPreservesIndependentProjectAccessHTTP(t *testing.T) {
	integration := newIdentityIntegration(t)
	owner, member := identityBrowser(t), identityBrowser(t)
	ownerUser := integration.login(t, owner, "alice")
	memberUser := integration.login(t, member, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	call := func(client *http.Client, method, path string, input any, status int) []byte {
		t.Helper()
		body := ""
		if input != nil {
			body = jsonBody(t, input)
		}
		_, data := identityRequest(t, client, method, integration.server.URL+path, body, origin, status)
		return data
	}
	team := identityDecode[api.Team](t, call(owner, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Shared team", ExpectedUserID: ownerUser.ID}, http.StatusCreated))
	teamInvitation := identityDecode[api.CreatedTeamInvitation](t, call(owner, http.MethodPost, "/api/v1/teams/"+team.ID+"/invitations", api.ProjectInvitationMutationRequest{ExpectedUserID: ownerUser.ID}, http.StatusCreated))
	teamLink, err := url.Parse(teamInvitation.Link)
	if err != nil || teamLink.Fragment == "" {
		t.Fatal("missing Team invitation token")
	}
	joined := identityDecode[api.TeamInvitationAcceptance](t, call(member, http.MethodPost, "/api/v1/team-invitations/accept", api.AcceptProjectInvitationRequest{Token: teamLink.Fragment, ExpectedUserID: memberUser.ID}, http.StatusOK))
	project := identityDecode[api.ProjectDocument](t, call(owner, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Shared project", RepoURL: "https://example.test/independent-grant", TeamID: &team.ID, ExpectedUserID: ownerUser.ID}, http.StatusCreated))
	base := "/api/v1/projects/" + project.ID
	projectInvitation := identityDecode[api.CreatedProjectInvitation](t, call(owner, http.MethodPost, base+"/invitations", api.ProjectInvitationMutationRequest{ExpectedUserID: ownerUser.ID}, http.StatusCreated))
	projectLink, err := url.Parse(projectInvitation.Link)
	if err != nil || projectLink.Fragment == "" {
		t.Fatal("missing Project invitation token")
	}
	accepted := identityDecode[api.ProjectInvitationAcceptance](t, call(member, http.MethodPost, "/api/v1/invitations/accept", api.AcceptProjectInvitationRequest{Token: projectLink.Fragment, ExpectedUserID: memberUser.ID}, http.StatusOK))
	if !accepted.Joined || !accepted.Consumed || accepted.DirectGrant.UserID != memberUser.ID || accepted.DirectGrant.Role != "member" {
		t.Fatalf("independent grant not created: %+v", accepted)
	}
	before := identityDecode[api.ProjectAccess](t, call(member, http.MethodGet, base+"/access", nil, http.StatusOK))
	if before.TeamRole == nil || *before.TeamRole != "member" || before.DirectGrant == nil || !reflect.DeepEqual(*before.DirectGrant, accepted.DirectGrant) {
		t.Fatalf("initial access does not have both sources: %+v", before)
	}
	leave := api.RemoveTeamMemberRequest{Version: joined.Membership.Version, ExpectedUserID: memberUser.ID}
	receipt := identityDecode[api.RemoveTeamMemberReceipt](t, call(member, http.MethodDelete, "/api/v1/teams/"+team.ID+"/members/"+memberUser.ID, leave, http.StatusOK))
	if !receipt.Removed || receipt.TeamID != team.ID || receipt.UserID != memberUser.ID || receipt.ActorRole != nil {
		t.Fatalf("self-exit receipt: %+v", receipt)
	}
	denial := identityDecode[api.ErrorResponse](t, call(member, http.MethodGet, "/api/v1/teams/"+team.ID, nil, http.StatusNotFound))
	if denial.Error.Code != "not_found" {
		t.Fatalf("Team remains visible after exit: %+v", denial)
	}
	read := identityDecode[api.ProjectDocument](t, call(member, http.MethodGet, base, nil, http.StatusOK))
	after := identityDecode[api.ProjectAccess](t, call(member, http.MethodGet, base+"/access", nil, http.StatusOK))
	if read.ID != project.ID || after.TeamRole != nil || after.EffectiveRole != "member" || !reflect.DeepEqual(after.DirectGrant, before.DirectGrant) {
		t.Fatalf("self-exit lost or changed independent Project access: %+v", after)
	}
}
