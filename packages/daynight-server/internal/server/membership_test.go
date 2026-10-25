package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type membershipHarness struct {
	*authHarness
	admin    *http.Cookie
	member   *http.Cookie
	outsider *http.Cookie
	project  core.Project
	adminID  string
	memberID string
}

func membershipTestHarness(t *testing.T) *membershipHarness {
	t.Helper()
	h := &membershipHarness{authHarness: authTestHarness(t)}
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	NewMembershipRoutes(service.NewMemberships(h.database), h.auth, logger).RegisterRoutes(mux)
	h.handler = RequestLogging(logger, mux)
	h.admin = h.login(t, "membership-admin")
	h.member = h.login(t, "membership-member")
	h.outsider = h.login(t, "membership-outsider")
	principal, err := h.auth.identity.Authenticate(context.Background(), core.SessionCredential, h.admin.Value)
	if err != nil {
		t.Fatal(err)
	}
	h.adminID = principal.UserID
	h.project, err = service.NewProjects(h.database).Create(context.Background(), principal, service.CreateProject{Name: "Shared project", RepoURL: "https://example.com/shared.git"})
	if err != nil {
		t.Fatal(err)
	}
	h.memberID = decodeResponse[api.User](t, h.call("GET", "/api/v1/me", "", h.member), 200).ID
	return h
}

func (h *membershipHarness) call(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	var cookies []*http.Cookie
	if cookie != nil {
		cookies = []*http.Cookie{cookie}
	}
	return h.request(method, path, body, cookies, nil, h.auth.origin)
}

func (h *membershipHarness) invitation(t *testing.T) (api.CreatedProjectInvitation, string) {
	t.Helper()
	response := h.call("POST", "/api/v1/projects/"+h.project.ID+"/invitations", `{}`, h.admin)
	invitation := decodeResponse[api.CreatedProjectInvitation](t, response, 201)
	link, err := url.Parse(invitation.Link)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header().Get("Cache-Control") != "no-store" || link.Scheme+"://"+link.Host != h.auth.origin || link.Path != "/invitations" || link.RawQuery != "" || link.Fragment == "" || response.Header().Get("Location") != "/api/v1/projects/"+h.project.ID+"/invitations/"+invitation.ID {
		t.Fatalf("invitation disclosure: %d %+v", response.Code, invitation)
	}
	if invitation.CreatedBy != h.adminID || invitation.ExpiresAt.Sub(invitation.CreatedAt) != 7*24*time.Hour || invitation.ConsumedAt != nil || invitation.RevokedAt != nil {
		t.Fatalf("invitation metadata: %+v", invitation)
	}
	var stored []byte
	if err := h.database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM project_invitations WHERE id=$1`, invitation.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(link.Fragment))
	if !bytes.Equal(stored, want[:]) {
		t.Fatal("invitation secret was not stored as its digest")
	}
	return invitation, link.Fragment
}

func invitationBody(token string) string {
	encoded, _ := json.Marshal(api.InspectProjectInvitationRequest{Token: token})
	return string(encoded)
}

func TestMembershipHTTPRolesVersionsAndCredentials(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	assertProjectError(t, h.call("GET", base+"/members", "", nil), 401, "unauthenticated")
	assertProjectError(t, h.call("GET", base+"/members", "", h.member), 404, "not_found")
	assertProjectError(t, h.call("GET", "/api/v1/projects/00000000-0000-0000-0000-000000000000/members", "", h.admin), 404, "not_found")
	empty := decodeResponse[api.ProjectInvitationList](t, h.call("GET", base+"/invitations", "", h.admin), 200)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatal("empty invitation list must contain an array")
	}
	_, token := h.invitation(t)
	member := decodeResponse[api.ProjectMember](t, h.call("POST", "/api/v1/invitations/accept", invitationBody(token), h.member), 200)
	if member.Role != "member" || member.Version < 1 || member.UserID != h.memberID || member.Email != nil || member.Name != nil || member.AvatarURL != nil {
		t.Fatalf("new member response: %+v", member)
	}
	listResponse := h.call("GET", base+"/members", "", h.member)
	list := decodeResponse[api.ProjectMemberList](t, listResponse, 200)
	if len(list.Items) != 2 || listResponse.Header().Get("Cache-Control") != "no-store" || strings.Contains(listResponse.Body.String(), "github:") || strings.Contains(listResponse.Body.String(), "uniAuth") {
		t.Fatalf("member list: %s", listResponse.Body)
	}
	memberPath := base + "/members/" + h.memberID
	var adminVersion int64
	for _, item := range list.Items {
		if item.UserID == h.adminID {
			adminVersion = item.Version
		}
	}
	memberBody := func(role string) string { return fmt.Sprintf(`{"version":%d,"role":%q}`, member.Version, role) }
	adminBody := func(role string) string { return fmt.Sprintf(`{"version":%d,"role":%q}`, adminVersion, role) }
	for _, call := range []struct{ method, path, body string }{
		{"GET", base + "/invitations", ""}, {"POST", base + "/invitations", `{}`},
		{"PATCH", memberPath, `{"version":1,"role":"admin"}`}, {"DELETE", memberPath, `{"version":1}`},
		{"DELETE", base + "/invitations/00000000-0000-0000-0000-000000000000", ""},
	} {
		assertProjectError(t, h.call(call.method, call.path, call.body, h.member), 403, "forbidden")
		assertProjectError(t, h.call(call.method, call.path, call.body, h.outsider), 404, "not_found")
	}
	assertProjectError(t, h.call("PATCH", base+"/members/"+h.adminID, adminBody("member"), h.admin), 409, "last_admin")
	assertProjectError(t, h.call("DELETE", base+"/members/"+h.adminID, fmt.Sprintf(`{"version":%d}`, adminVersion), h.admin), 409, "last_admin")
	unchanged := decodeResponse[api.ProjectMember](t, h.call("PATCH", memberPath, memberBody("member"), h.admin), 200)
	if unchanged.Version != member.Version {
		t.Fatal("no-op role change advanced the observed version")
	}
	promoted := decodeResponse[api.ProjectMember](t, h.call("PATCH", memberPath, memberBody("admin"), h.admin), 200)
	if promoted.Version <= member.Version || promoted.Role != "admin" {
		t.Fatalf("promotion: %+v", promoted)
	}
	assertProjectError(t, h.call("PATCH", memberPath, memberBody("member"), h.admin), 409, "version_conflict")
	assertProjectError(t, h.call("DELETE", memberPath, fmt.Sprintf(`{"version":%d}`, member.Version), h.admin), 409, "version_conflict")
	pat := decodeResponse[api.CreatedPersonalAccessToken](t, h.call("POST", "/api/v1/me/tokens", `{"name":"project administrator","expiresAt":null}`, h.member), 201)
	if response := h.request("GET", base+"/members", "", nil, []string{"Bearer " + pat.Token}, ""); response.Code != 200 {
		t.Fatalf("PAT membership access: %d %s", response.Code, response.Body)
	}
	demotion := h.request("PATCH", base+"/members/"+h.adminID, adminBody("member"), nil, []string{"Bearer " + pat.Token}, "https://foreign.test")
	if demotion.Code != 200 {
		t.Fatalf("PAT project administration: %d %s", demotion.Code, demotion.Body)
	}
	demoted := decodeResponse[api.ProjectMember](t, demotion, 200)
	if response := h.call("DELETE", base+"/members/"+h.adminID, fmt.Sprintf(`{"version":%d}`, demoted.Version), h.member); response.Code != 204 {
		t.Fatalf("remove member: %d %s", response.Code, response.Body)
	}
	assertProjectError(t, h.call("GET", base+"/members", "", h.admin), 404, "not_found")
	assertProjectError(t, h.request("GET", base+"/members", "", []*http.Cookie{h.member}, []string{"Bearer invalid"}, ""), 401, "unauthenticated")
	for _, origin := range []string{"", "null", "https://foreign.test"} {
		assertProjectError(t, h.request("POST", base+"/invitations", `{}`, []*http.Cookie{h.member}, nil, origin), 403, "forbidden")
	}
	for _, secret := range []string{token, pat.Token, h.admin.Value, h.member.Value} {
		if strings.Contains(h.logs.String(), secret) {
			t.Fatal("membership request logged a credential")
		}
	}
	if !strings.Contains(h.logs.String(), `"component":"membership"`) || !strings.Contains(h.logs.String(), `"project_id":"`+h.project.ID+`"`) || !strings.Contains(h.logs.String(), `"user_id":"`+h.memberID+`"`) {
		t.Fatal("membership logs lost user or project correlation")
	}
}

func TestMembershipHTTPInvitationLifecycle(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID + "/invitations"
	invitation, token := h.invitation(t)
	for _, method := range []string{"GET", "HEAD"} {
		for _, path := range []string{"/api/v1/invitations/inspect", "/api/v1/invitations/accept"} {
			response := h.call(method, path, invitationBody(token), h.member)
			if response.Code != 405 || response.Header().Get("Allow") != "POST" {
				t.Fatalf("navigation consumed an invitation: %s %s %d", method, path, response.Code)
			}
		}
	}
	for range 2 {
		response := h.call("POST", "/api/v1/invitations/inspect", invitationBody(token), h.member)
		inspection := decodeResponse[api.ProjectInvitationInspection](t, response, 200)
		if inspection.ProjectID != h.project.ID || inspection.ProjectName != h.project.Name || inspection.Member != nil || strings.Contains(response.Body.String(), "repoUrl") || strings.Contains(response.Body.String(), token) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("minimal inspection: %s", response.Body)
		}
	}
	inspection := decodeResponse[api.ProjectInvitationInspection](t, h.call("POST", "/api/v1/invitations/inspect", invitationBody(token), h.admin), 200)
	if inspection.Member == nil || inspection.Member.Role != "admin" {
		t.Fatal("existing member was not identified")
	}
	decodeResponse[api.ProjectMember](t, h.call("POST", "/api/v1/invitations/accept", invitationBody(token), h.admin), 200)
	listResponse := h.call("GET", base, "", h.admin)
	list := decodeResponse[api.ProjectInvitationList](t, listResponse, 200)
	if len(list.Items) != 1 || list.Items[0].ConsumedAt != nil || listResponse.Header().Get("Cache-Control") != "no-store" || strings.Contains(listResponse.Body.String(), token) || strings.Contains(listResponse.Body.String(), "link") || strings.Contains(listResponse.Body.String(), "hash") {
		t.Fatalf("existing member consumed invitation or leaked secret: %s", listResponse.Body)
	}
	decodeResponse[api.ProjectMember](t, h.call("POST", "/api/v1/invitations/accept", invitationBody(token), h.member), 200)
	for _, action := range []string{"inspect", "accept"} {
		assertProjectError(t, h.call("POST", "/api/v1/invitations/"+action, invitationBody(token), h.outsider), 410, "invitation_unavailable")
	}
	list = decodeResponse[api.ProjectInvitationList](t, h.call("GET", base, "", h.admin), 200)
	if list.Items == nil || len(list.Items) != 0 {
		t.Fatal("consumed invitation remained available in the invitation list")
	}
	invitation, revoked := h.invitation(t)
	for range 2 {
		if response := h.call("DELETE", base+"/"+invitation.ID, "", h.admin); response.Code != 204 {
			t.Fatalf("revocation: %d %s", response.Code, response.Body)
		}
	}
	assertProjectError(t, h.call("POST", "/api/v1/invitations/accept", invitationBody(revoked), h.outsider), 410, "invitation_unavailable")
	invitation, expired := h.invitation(t)
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE project_invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE id=$1`, invitation.ID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.call("POST", "/api/v1/invitations/inspect", invitationBody(expired), h.outsider), 410, "invitation_unavailable")
	assertProjectError(t, h.call("POST", "/api/v1/invitations/accept", invitationBody(expired), h.outsider), 410, "invitation_unavailable")
	for _, secret := range []string{token, revoked, expired} {
		if strings.Contains(h.logs.String(), secret) {
			t.Fatal("invitation secret entered logs")
		}
	}
}

func TestMembershipHTTPDatabaseFailuresAreVisible(t *testing.T) {
	h := membershipTestHarness(t)
	invitation, token := h.invitation(t)
	base := "/api/v1/projects/" + h.project.ID
	if _, err := h.database.Pool.Exec(context.Background(), `DROP TABLE project_invitations`); err != nil {
		t.Fatal(err)
	}
	for _, call := range []struct{ method, path, body string }{
		{"GET", base + "/invitations", ""},
		{"POST", base + "/invitations", `{}`},
		{"DELETE", base + "/invitations/" + invitation.ID, ""},
		{"POST", "/api/v1/invitations/inspect", invitationBody(token)},
		{"POST", "/api/v1/invitations/accept", invitationBody(token)},
	} {
		response := h.call(call.method, call.path, call.body, h.admin)
		assertProjectError(t, response, 500, "internal_error")
		if strings.Contains(response.Body.String(), token) || strings.Contains(response.Body.String(), "project_invitations") {
			t.Fatal("database failure disclosed internal details")
		}
	}
	if _, err := h.database.Pool.Exec(context.Background(), `DROP TABLE project_members`); err != nil {
		t.Fatal(err)
	}
	for _, call := range []struct{ method, path, body string }{
		{"GET", base + "/members", ""},
		{"PATCH", base + "/members/" + h.adminID, `{"version":1,"role":"admin"}`},
		{"DELETE", base + "/members/" + h.adminID, `{"version":1}`},
	} {
		assertProjectError(t, h.call(call.method, call.path, call.body, h.admin), 500, "internal_error")
	}
	if strings.Contains(h.logs.String(), token) || !strings.Contains(h.logs.String(), `"cause":"database"`) {
		t.Fatal("database failure lost safe diagnostics")
	}
}

func TestMembershipHTTPStrictInputAndErrorMapping(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	member := base + "/members/" + h.adminID
	for _, call := range []struct{ method, path, body string }{
		{"GET", "/api/v1/projects/bad/members", ""}, {"GET", base + "/members?extra=true", ""},
		{"GET", "/api/v1/projects/bad/invitations", ""}, {"GET", base + "/invitations?limit=1", ""},
		{"PATCH", "/api/v1/projects/bad/members/" + h.adminID, `{}`}, {"DELETE", "/api/v1/projects/bad/members/" + h.adminID, `{}`},
		{"POST", "/api/v1/projects/bad/invitations", `{}`}, {"DELETE", "/api/v1/projects/bad/invitations/" + h.adminID, ""},
		{"PATCH", member, `{"role":"member"}`}, {"PATCH", member, `{"version":1}`},
		{"PATCH", member, `{"version":1,"role":null}`}, {"PATCH", member, `{"version":1,"role":"owner"}`},
		{"PATCH", member, `{"version":1,"role":"admin","userId":"fake"}`},
		{"PATCH", base + "/members/bad", `{"version":1,"role":"admin"}`},
		{"DELETE", member, `{}`}, {"DELETE", member, `{"version":1,"role":"member"}`},
		{"DELETE", base + "/members/bad", `{"version":1}`},
		{"POST", base + "/invitations", `{"days":30}`}, {"POST", base + "/invitations", ""},
		{"DELETE", base + "/invitations/bad", ""},
		{"POST", "/api/v1/invitations/inspect", `{}`}, {"POST", "/api/v1/invitations/inspect", `{"token":null}`},
		{"POST", "/api/v1/invitations/accept", `{"token":12}`}, {"POST", "/api/v1/invitations/accept", `{"token":"a","token":"b"}`},
	} {
		t.Run(fmt.Sprintf("%s %s %s", call.method, call.path, call.body), func(t *testing.T) {
			assertProjectError(t, h.call(call.method, call.path, call.body, h.admin), 400, "invalid_input")
		})
	}
	for _, version := range []string{"null", "0", "-1", "1.5", `"1"`, "9223372036854775808", "1e0"} {
		assertProjectError(t, h.call("PATCH", member, `{"version":`+version+`,"role":"admin"}`, h.admin), 400, "invalid_input")
		assertProjectError(t, h.call("DELETE", member, `{"version":`+version+`}`, h.admin), 400, "invalid_input")
	}
	request := httptest.NewRequest("POST", base+"/invitations", strings.NewReader(`{}`))
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("Origin", h.auth.origin)
	request.Header.Set("Content-Type", "text/plain")
	request.AddCookie(h.admin)
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	request = httptest.NewRequest("POST", base+"/invitations", strings.NewReader(`{}`))
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("Content-Type", "application/json")
	request.Header["Origin"] = []string{h.auth.origin, h.auth.origin}
	request.AddCookie(h.admin)
	response = httptest.NewRecorder()
	h.handler.ServeHTTP(response, request)
	assertProjectError(t, response, 403, "forbidden")
	assertProjectError(t, h.call("DELETE", base+"/members/00000000-0000-0000-0000-000000000000", `{"version":1}`, h.admin), 404, "not_found")
	assertProjectError(t, h.call("PATCH", base+"/members/00000000-0000-0000-0000-000000000000", `{"version":1,"role":"member"}`, h.admin), 404, "not_found")
	if got := h.call("DELETE", base+"/invitations/00000000-0000-0000-0000-000000000000", "", h.admin); got.Code != 204 {
		t.Fatal("revocation must be idempotent")
	}
	for _, action := range []string{"inspect", "accept"} {
		assertProjectError(t, h.call("POST", "/api/v1/invitations/"+action, `{"token":"bad"}`, h.admin), 410, "invitation_unavailable")
	}
}
