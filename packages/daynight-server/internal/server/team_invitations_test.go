package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"log/slog"
)

func TestTeamInvitationHTTP(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	teamRoutes(mux, service.NewTeams(h.database), h.auth, logger)
	h.handler = RequestLogging(logger, mux)
	admin, member := h.login(t, "team-invite-admin"), h.login(t, "team-invite-member")
	adminCookies, memberCookies := []*http.Cookie{admin}, []*http.Cookie{member}
	adminUser := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", adminCookies, nil, ""), 200)
	memberUser := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", memberCookies, nil, ""), 200)
	team := decodeResponse[api.Team](t, h.request("POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Invite Team", ExpectedUserID: adminUser.ID}), adminCookies, nil, h.auth.origin), 201)
	path := "/api/v1/teams/" + team.ID + "/invitations"
	wrong := jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: memberUser.ID})
	assertProjectError(t, h.request("POST", path, wrong, adminCookies, nil, h.auth.origin), 409, "identity_mismatch")
	response := h.request("POST", path, jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: adminUser.ID}), adminCookies, nil, h.auth.origin)
	invitation := decodeResponse[api.CreatedTeamInvitation](t, response, 201)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Path != "/team-invitations" || link.RawQuery != "" || !strings.HasPrefix(link.Fragment, "dnteam_") || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Location") != path+"/"+invitation.ID {
		t.Fatalf("link %#v %v", link, err)
	}
	list := decodeResponse[api.TeamInvitationList](t, h.request("GET", path, "", adminCookies, nil, ""), 200)
	if len(list.Items) != 1 || list.Items[0].ID != invitation.ID {
		t.Fatal("list", list)
	}
	tokenBody := jsonBody(t, api.InspectProjectInvitationRequest{Token: link.Fragment})
	previewResponse := h.request("POST", "/api/v1/team-invitations/inspect", tokenBody, memberCookies, nil, h.auth.origin)
	preview := decodeResponse[api.TeamInvitationInspection](t, previewResponse, 200)
	if preview.Team.ID != team.ID || preview.Team.Name == nil || *preview.Team.Name != "Invite Team" || preview.Membership != nil || previewResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("preview", preview)
	}
	acceptPath := "/api/v1/team-invitations/accept"
	wrongBody := jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: adminUser.ID})
	assertProjectError(t, h.request("POST", acceptPath, wrongBody, memberCookies, nil, h.auth.origin), 409, "identity_mismatch")
	body := jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: memberUser.ID})
	accepted := decodeResponse[api.TeamInvitationAcceptance](t, h.request("POST", acceptPath, body, memberCookies, nil, h.auth.origin), 200)
	if accepted.Team.ID != team.ID || accepted.Membership.UserID != memberUser.ID || accepted.Membership.TeamID != team.ID || accepted.Membership.Role != "member" || !accepted.Joined || !accepted.Consumed {
		t.Fatal("accept", accepted)
	}
	assertProjectError(t, h.request("POST", acceptPath, body, memberCookies, nil, h.auth.origin), 404, "invitation_unavailable")
	var count int
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, memberUser.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("membership", count, err)
	}
	if strings.Contains(h.logs.String(), link.Fragment) {
		t.Fatal("secret in logs")
	}
}
