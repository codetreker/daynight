package team

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func TestTeamInvitationHTTP(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	admin, member := h.Login(t, "team-invite-admin"), h.Login(t, "team-invite-member")
	adminCookies, memberCookies := []*http.Cookie{admin}, []*http.Cookie{member}
	adminUser := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", adminCookies, nil, ""), 200)
	memberUser := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", memberCookies, nil, ""), 200)
	team := decodeResponse[api.Team](t, h.Request("POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Invite Team", ExpectedUserID: adminUser.ID}), adminCookies, nil, h.Origin), 201)
	path := "/api/v1/teams/" + team.ID + "/invitations"
	wrong := jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: memberUser.ID})
	assertProjectError(t, h.Request("POST", path, wrong, adminCookies, nil, h.Origin), 409, "identity_mismatch")
	response := h.Request("POST", path, jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: adminUser.ID}), adminCookies, nil, h.Origin)
	invitation := decodeResponse[api.CreatedTeamInvitation](t, response, 201)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Path != "/team-invitations" || link.RawQuery != "" || !strings.HasPrefix(link.Fragment, "dnteam_") || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Location") != path+"/"+invitation.ID {
		t.Fatalf("link %#v %v", link, err)
	}
	listResponse := h.Request("GET", path, "", adminCookies, nil, "")
	list := decodeResponse[api.TeamInvitationList](t, listResponse, 200)
	if len(list.Items) != 1 || list.Items[0].ID != invitation.ID {
		t.Fatal("list", list)
	}
	var raw struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &raw); err != nil || len(raw.Items) != 1 {
		t.Fatalf("invalid invitation list: %v", err)
	}
	if _, exists := raw.Items[0]["link"]; exists || strings.Contains(listResponse.Body.String(), link.Fragment) {
		t.Fatal("invitation list exposed the one-time link or token")
	}
	tokenBody := jsonBody(t, api.InspectProjectInvitationRequest{Token: link.Fragment})
	previewResponse := h.Request("POST", "/api/v1/team-invitations/inspect", tokenBody, memberCookies, nil, h.Origin)
	preview := decodeResponse[api.TeamInvitationInspection](t, previewResponse, 200)
	if preview.Team.ID != team.ID || preview.Team.Name == nil || *preview.Team.Name != "Invite Team" || preview.Membership != nil || previewResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("preview", preview)
	}
	acceptPath := "/api/v1/team-invitations/accept"
	wrongBody := jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: adminUser.ID})
	assertProjectError(t, h.Request("POST", acceptPath, wrongBody, memberCookies, nil, h.Origin), 409, "identity_mismatch")
	body := jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: memberUser.ID})
	accepted := decodeResponse[api.TeamInvitationAcceptance](t, h.Request("POST", acceptPath, body, memberCookies, nil, h.Origin), 200)
	if accepted.Team.ID != team.ID || accepted.Membership.UserID != memberUser.ID || accepted.Membership.TeamID != team.ID || accepted.Membership.Role != "member" || !accepted.Joined || !accepted.Consumed {
		t.Fatal("accept", accepted)
	}
	assertProjectError(t, h.Request("POST", acceptPath, body, memberCookies, nil, h.Origin), 404, "invitation_unavailable")
	var count int
	if err = h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, memberUser.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("membership", count, err)
	}
	if strings.Contains(h.Logs.String(), link.Fragment) {
		t.Fatal("secret in logs")
	}
}

func TestTeamInvitationHTTPRefusalsAndRevoke(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	admin, outsider := h.Login(t, "invite-admin-refusals"), h.Login(t, "invite-outsider-refusals")
	adminCookies, outsiderCookies := []*http.Cookie{admin}, []*http.Cookie{outsider}
	adminUser := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", adminCookies, nil, ""), 200)
	outsiderUser := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", outsiderCookies, nil, ""), 200)
	team := decodeResponse[api.Team](t, h.Request("POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Invite Refusals", ExpectedUserID: adminUser.ID}), adminCookies, nil, h.Origin), 201)
	path := "/api/v1/teams/" + team.ID + "/invitations"
	actor := jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: adminUser.ID})
	created := decodeResponse[api.CreatedTeamInvitation](t, h.Request("POST", path, actor, adminCookies, nil, h.Origin), 201)
	link, err := url.Parse(created.Link)
	if err != nil {
		t.Fatal(err)
	}
	inspectPath := "/api/v1/team-invitations/inspect"
	body := jsonBody(t, api.InspectProjectInvitationRequest{Token: link.Fragment})
	preview := decodeResponse[api.TeamInvitationInspection](t, h.Request("POST", inspectPath, body, adminCookies, nil, h.Origin), 200)
	if preview.Membership == nil || preview.Membership.UserID != adminUser.ID || preview.Membership.Role != "admin" {
		t.Fatalf("existing member preview: %#v", preview)
	}
	assertProjectError(t, h.Request("GET", path+"?limit=1", "", adminCookies, nil, ""), 400, "invalid_input")
	assertProjectError(t, h.Request("GET", path, "", outsiderCookies, nil, ""), 404, "not_found")
	assertProjectError(t, h.Request("POST", inspectPath, `{"token":null}`, adminCookies, nil, h.Origin), 400, "invalid_input")
	assertProjectError(t, h.Request("POST", inspectPath, `{"token":"invalid"}`, adminCookies, nil, h.Origin), 404, "invitation_unavailable")

	revoke := path + "/" + created.ID
	wrong := jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: outsiderUser.ID})
	assertProjectError(t, h.Request("DELETE", revoke, wrong, adminCookies, nil, h.Origin), 409, "identity_mismatch")
	assertProjectError(t, h.Request("DELETE", revoke, `{}`, adminCookies, nil, h.Origin), 400, "invalid_input")
	assertProjectError(t, h.Request("DELETE", revoke+"?unexpected=1", actor, adminCookies, nil, h.Origin), 400, "invalid_input")
	for _, changed := range []bool{true, false} {
		response := h.Request("DELETE", revoke, actor, adminCookies, nil, h.Origin)
		receipt := decodeResponse[struct {
			TeamID       string `json:"teamId"`
			InvitationID string `json:"invitationId"`
			Changed      bool   `json:"changed"`
		}](t, response, 200)
		if receipt.TeamID != team.ID || receipt.InvitationID != created.ID || receipt.Changed != changed || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("revoke: %#v", receipt)
		}
	}
	assertProjectError(t, h.Request("POST", inspectPath, body, outsiderCookies, nil, h.Origin), 404, "invitation_unavailable")
	if strings.Contains(h.Logs.String(), link.Fragment) {
		t.Fatal("secret in logs")
	}
}
