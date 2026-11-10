package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func invitationBody(token string) string {
	encoded, _ := json.Marshal(api.InspectProjectInvitationRequest{Token: token})
	return string(encoded)
}
func invitationActorBody(userID string) string {
	encoded, _ := json.Marshal(api.ProjectInvitationMutationRequest{ExpectedUserID: userID})
	return string(encoded)
}
func invitationAcceptBody(token, userID string) string {
	encoded, _ := json.Marshal(api.AcceptProjectInvitationRequest{Token: token, ExpectedUserID: userID})
	return string(encoded)
}
func memberRoleBody(t *testing.T, version int64, role, expectedUserID string) string {
	t.Helper()
	return jsonBody(t, api.SetProjectMemberRoleRequest{Version: version, Role: role, ExpectedUserID: expectedUserID})
}
func memberRemovalBody(t *testing.T, version int64, expectedUserID string) string {
	t.Helper()
	return jsonBody(t, api.RemoveProjectMemberRequest{Version: version, ExpectedUserID: expectedUserID})
}

type membershipContextKey struct{}

func membershipCall(t *testing.T, h *httpHarness, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := h.request(method, path, body)
	request = request.WithContext(context.WithValue(request.Context(), membershipContextKey{}, t))
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	return response
}

func membershipExpectation(t *testing.T, h *httpHarness, wantProject string) func(context.Context, model.Principal, string) {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != 1 {
			t.Errorf("business calls = %d, want 1", calls)
		}
	})
	return func(ctx context.Context, p model.Principal, project string) {
		t.Helper()
		calls++
		if ctx.Value(membershipContextKey{}) != t || p != h.Principal || project != wantProject {
			t.Fatalf("business propagation: principal=%+v project=%q context=%v", p, project, ctx.Value(membershipContextKey{}))
		}
	}
}

func membershipGrant(h *httpHarness, version int64, role model.ProjectRole) model.ProjectGrant {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("fixture", 3600))
	return model.ProjectGrant{ProjectID: h.Project.ID, UserID: h.Principal.UserID, Role: role, Version: version, CreatedAt: at, UpdatedAt: at.Add(time.Hour)}
}

func membershipAccess(h *httpHarness, grant *model.ProjectGrant) model.ProjectAccess {
	return model.ProjectAccess{ProjectID: h.Project.ID, UserID: h.Principal.UserID, Role: model.ProjectAdmin, DirectGrant: grant, Ownership: h.Project.Ownership, OwnerTeam: model.TeamRef{ID: h.Project.Ownership.TeamID, Kind: "personal"}, CanTransfer: true}
}

type membershipHTTPCase struct {
	name, method, path, body string
	configure                func(*testing.T, *httpHarness, error)
}

func membershipCases(h *httpHarness) []membershipHTTPCase {
	base := "/api/v1/projects/" + h.Project.ID
	grant := membershipGrant(h, 7, model.ProjectMemberRole)
	access := membershipAccess(h, &grant)
	invitation := model.ProjectInvitation{ID: "00000000-0000-4000-8000-000000000057", ProjectID: h.Project.ID, CreatedBy: h.Principal.UserID, CreatedAt: grant.CreatedAt, ExpiresAt: grant.CreatedAt.Add(7 * 24 * time.Hour), TokenHash: []byte("private-hash")}
	const token = "dninvite_private-invitation-secret"
	return []membershipHTTPCase{
		{"list", "GET", base + "/members", "", func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.ListWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
				check(ctx, p, id)
				return coreproject.ProjectParticipants{Items: []model.ProjectParticipant{{UserID: p.UserID, EffectiveRole: model.ProjectMemberRole, DirectGrant: &grant}}, ActorAccess: access}, failure
			}
		}},
		{"set_role", "PATCH", base + "/members/" + h.Principal.UserID, fmt.Sprintf(`{"version":7,"role":"admin","expectedUserId":%q}`, h.Principal.UserID), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.SetRoleFunc = func(ctx context.Context, p model.Principal, id, user string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
				check(ctx, p, id)
				if user != p.UserID || input != (coreproject.SetProjectMemberRole{Version: 7, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}) {
					t.Fatalf("role input: %q %+v", user, input)
				}
				return grant, failure
			}
		}},
		{"remove", "DELETE", base + "/members/" + h.Principal.UserID, fmt.Sprintf(`{"version":7,"expectedUserId":%q}`, h.Principal.UserID), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.RemoveFunc = func(ctx context.Context, p model.Principal, id, user string, input coreproject.RemoveProjectMember) error {
				check(ctx, p, id)
				if user != p.UserID || input != (coreproject.RemoveProjectMember{Version: 7, ExpectedUserID: p.UserID}) {
					t.Fatalf("remove input: %q %+v", user, input)
				}
				return failure
			}
		}},
		{"list_invitations", "GET", base + "/invitations", "", func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.ListInvitationsFunc = func(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
				check(ctx, p, id)
				return []model.ProjectInvitation{invitation}, failure
			}
		}},
		{"create_invitation", "POST", base + "/invitations", invitationActorBody(h.Principal.UserID), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.CreateInvitationFunc = func(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error) {
				check(ctx, p, id)
				if expected != p.UserID {
					t.Fatalf("expected actor = %q", expected)
				}
				return coreproject.MintedInvitation{Invitation: invitation, Secret: token}, failure
			}
		}},
		{"revoke_invitation", "DELETE", base + "/invitations/" + invitation.ID, invitationActorBody(h.Principal.UserID), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, h.Project.ID)
			h.Memberships.RevokeInvitationFunc = func(ctx context.Context, p model.Principal, id, invite, expected string) error {
				check(ctx, p, id)
				if invite != invitation.ID || expected != p.UserID {
					t.Fatalf("revoke: %q %q", invite, expected)
				}
				return failure
			}
		}},
		{"inspect_invitation", "POST", "/api/v1/invitations/inspect", invitationBody(token), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, "")
			h.Memberships.InspectInvitationFunc = func(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error) {
				check(ctx, p, "")
				if secret != token {
					t.Fatalf("token = %q", secret)
				}
				return coreproject.InvitationInspection{ProjectID: h.Project.ID, ProjectName: h.Project.Name}, failure
			}
		}},
		{"accept_invitation", "POST", "/api/v1/invitations/accept", invitationAcceptBody(token, h.Principal.UserID), func(t *testing.T, h *httpHarness, failure error) {
			check := membershipExpectation(t, h, "")
			h.Memberships.AcceptInvitationFunc = func(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error) {
				check(ctx, p, "")
				if secret != token || expected != p.UserID {
					t.Fatalf("accept: %q %q", secret, expected)
				}
				return coreproject.InvitationAcceptance{ProjectID: h.Project.ID, DirectGrant: grant, Access: access, Joined: true, Consumed: true}, failure
			}
		}},
	}
}

func TestMembershipHTTPResultsAndPropagation(t *testing.T) {
	template := newHTTPHarness(t)
	for index, entry := range membershipCases(template) {
		t.Run(entry.name, func(t *testing.T) {
			h := newHTTPHarness(t)
			entry = membershipCases(h)[index]
			entry.configure(t, h, nil)
			response := membershipCall(t, h, entry.method, entry.path, entry.body)
			want := 200
			if entry.name == "remove" || entry.name == "revoke_invitation" {
				want = 204
			}
			if entry.name == "create_invitation" {
				want = 201
			}
			if response.Code != want || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response: %d %s %v", response.Code, response.Body, response.Header())
			}
			switch entry.name {
			case "list":
				value := decodeResponse[api.ProjectParticipantList](t, response, want)
				if len(value.Items) != 1 || value.Items[0].UserID != h.Principal.UserID || value.Items[0].DirectGrant.Version != 7 || value.ActorAccess.EffectiveRole != "admin" {
					t.Fatalf("participants: %+v", value)
				}
			case "set_role":
				value := decodeResponse[api.ProjectGrant](t, response, want)
				if value.Version != 7 || value.ProjectID != h.Project.ID || value.UserID != h.Principal.UserID || value.Role != "member" || value.CreatedAt.Location() != time.UTC || value.UpdatedAt.Location() != time.UTC {
					t.Fatalf("grant: %+v", value)
				}
			case "list_invitations":
				value := decodeResponse[api.ProjectInvitationList](t, response, want)
				if len(value.Items) != 1 || value.Items[0].ProjectID != h.Project.ID || value.Items[0].ConsumedAt != nil || value.Items[0].RevokedAt != nil || value.Items[0].CreatedBy != h.Principal.UserID || value.Items[0].ExpiresAt.Sub(value.Items[0].CreatedAt) != 7*24*time.Hour {
					t.Fatalf("invitations: %+v", value)
				}
				for _, private := range []string{"private-hash", "dninvite_", "tokenHash", "link"} {
					if strings.Contains(response.Body.String(), private) {
						t.Fatalf("invitation list disclosed %q", private)
					}
				}
			case "create_invitation":
				value := decodeResponse[api.CreatedProjectInvitation](t, response, want)
				link, err := url.Parse(value.Link)
				if err != nil {
					t.Fatal(err)
				}
				if link.Scheme+"://"+link.Host != h.Auth.Origin() || link.Path != "/invitations" || link.RawQuery != "" || link.Fragment != "dninvite_private-invitation-secret" || response.Header().Get("Location") != "/api/v1/projects/"+h.Project.ID+"/invitations/"+value.ID || value.CreatedBy != h.Principal.UserID || value.ExpiresAt.Sub(value.CreatedAt) != 7*24*time.Hour || value.ConsumedAt != nil || value.RevokedAt != nil {
					t.Fatalf("created invitation: %+v %v", value, response.Header())
				}
			case "inspect_invitation":
				value := decodeResponse[api.ProjectInvitationInspection](t, response, want)
				if value.ProjectID != h.Project.ID || value.ProjectName != h.Project.Name || value.DirectGrant != nil || value.Access != nil || strings.Contains(response.Body.String(), "repoUrl") || strings.Contains(response.Body.String(), "dninvite_") {
					t.Fatalf("inspection: %s", response.Body)
				}
			case "accept_invitation":
				value := decodeResponse[api.ProjectInvitationAcceptance](t, response, want)
				if value.ProjectID != h.Project.ID || value.DirectGrant.Version != 7 || value.DirectGrant.Role != "member" || !value.Joined || !value.Consumed || value.Access.EffectiveRole != "admin" {
					t.Fatalf("acceptance: %+v", value)
				}
			}
			if strings.Contains(h.Logs.String(), "dninvite_private-invitation-secret") || !strings.Contains(h.Logs.String(), `"component":"membership"`) || !strings.Contains(h.Logs.String(), `"user_id":"`+h.Principal.UserID+`"`) || !strings.Contains(h.Logs.String(), `"project_id":"`+h.Project.ID+`"`) {
				t.Fatalf("membership correlation or redaction: %s", &h.Logs)
			}
		})
	}
}

func TestMembershipHTTPDomainFailuresAndRedaction(t *testing.T) {
	template := newHTTPHarness(t)
	for index, entry := range membershipCases(template) {
		for _, failure := range []struct {
			name   string
			err    error
			status int
			code   string
		}{
			{"forbidden", &model.Fault{Code: "forbidden", Message: "Project administration is required."}, 403, "forbidden"},
			{"not_found", &model.Fault{Code: "not_found", Message: "Project member was not found."}, 404, "not_found"},
			{"identity_mismatch", &model.Fault{Code: "identity_mismatch", Message: "The signed-in account changed."}, 409, "identity_mismatch"},
			{"version_conflict", &model.Fault{Code: "version_conflict", Message: "Member version does not match."}, 409, "version_conflict"},
			{"invalid_input", &model.Fault{Code: "invalid_input", Message: "Invalid project mutation."}, 400, "invalid_input"},
			{"database", &store.Error{Phase: "query", SQLState: "42P01", DatabaseFailure: true, Cause: errors.New("relation project_invitations missing dninvite_private-invitation-secret")}, 500, "internal_error"},
		} {
			relevant := map[string][]string{
				"list":               {"not_found", "database"},
				"set_role":           {"forbidden", "not_found", "identity_mismatch", "version_conflict", "invalid_input", "database"},
				"remove":             {"forbidden", "not_found", "identity_mismatch", "version_conflict", "invalid_input", "database"},
				"list_invitations":   {"forbidden", "not_found", "database"},
				"create_invitation":  {"forbidden", "not_found", "identity_mismatch", "database"},
				"revoke_invitation":  {"forbidden", "not_found", "identity_mismatch", "database"},
				"inspect_invitation": {"database"},
				"accept_invitation":  {"identity_mismatch", "database"},
			}
			selected := false
			for _, name := range relevant[entry.name] {
				selected = selected || name == failure.name
			}
			if !selected {
				continue
			}
			t.Run(entry.name+"/"+failure.name, func(t *testing.T) {
				h := newHTTPHarness(t)
				entry := membershipCases(h)[index]
				entry.configure(t, h, failure.err)
				response := membershipCall(t, h, entry.method, entry.path, entry.body)
				assertProjectError(t, response, failure.status, failure.code)
				if response.Header().Get("Daynight-User-ID") != h.Principal.UserID || strings.Contains(response.Body.String(), "project_invitations") || strings.Contains(response.Body.String(), "dninvite_") || strings.Contains(h.Logs.String(), "dninvite_") {
					t.Fatalf("unsafe failure: %s logs=%s", response.Body, &h.Logs)
				}
				if entry.name == "list" && failure.name == "database" && (strings.Contains(response.Body.String(), `"items"`) || strings.Contains(response.Body.String(), h.Principal.UserID)) {
					t.Fatalf("integrity failure returned a partial roster: %s", response.Body)
				}
				if failure.name == "database" && !strings.Contains(h.Logs.String(), `"cause":"database"`) {
					t.Fatalf("database classification: %s", &h.Logs)
				}
			})
		}
	}
}

func TestMembershipHTTPStrictInputAndErrorMapping(t *testing.T) {
	h := newHTTPHarness(t)
	t.Cleanup(func() { h.assertCalls(map[string]int{}) })
	base := "/api/v1/projects/" + h.Project.ID
	member := base + "/members/" + h.Principal.UserID
	for _, call := range []struct{ method, path, body string }{
		{"GET", "/api/v1/projects/bad/members", ""}, {"GET", base + "/members?extra=true", ""}, {"GET", "/api/v1/projects/bad/invitations", ""}, {"GET", base + "/invitations?limit=1", ""},
		{"PATCH", "/api/v1/projects/bad/members/" + h.Principal.UserID, `{}`}, {"DELETE", "/api/v1/projects/bad/members/" + h.Principal.UserID, `{}`}, {"POST", "/api/v1/projects/bad/invitations", `{}`}, {"DELETE", "/api/v1/projects/bad/invitations/" + h.Principal.UserID, ""},
		{"PATCH", member, `{"role":"member"}`}, {"PATCH", member, `{"version":1}`}, {"PATCH", member, `{"version":1,"role":null}`}, {"PATCH", member, `{"version":1,"role":"owner"}`}, {"PATCH", member, `{"version":1,"role":"admin","userId":"fake"}`}, {"PATCH", base + "/members/bad", `{"version":1,"role":"admin"}`},
		{"DELETE", member, `{}`}, {"DELETE", member, `{"version":1,"role":"member"}`}, {"DELETE", base + "/members/bad", `{"version":1}`}, {"POST", base + "/invitations", `{"days":30}`}, {"POST", base + "/invitations", ""}, {"DELETE", base + "/invitations/bad", ""},
		{"POST", "/api/v1/invitations/inspect", `{}`}, {"POST", "/api/v1/invitations/inspect", `{"token":null}`}, {"POST", "/api/v1/invitations/accept", `{"token":12}`}, {"POST", "/api/v1/invitations/accept", `{"token":"a","token":"b"}`},
	} {
		t.Run(call.method+" "+call.path+" "+call.body, func(t *testing.T) {
			assertProjectError(t, membershipCall(t, h, call.method, call.path, call.body), 400, "invalid_input")
		})
	}
	for _, version := range []string{"null", "0", "-1", "1.5", `"1"`, "9223372036854775808", "1e0"} {
		assertProjectError(t, membershipCall(t, h, "PATCH", member, `{"version":`+version+`,"role":"admin"}`), 400, "invalid_input")
		assertProjectError(t, membershipCall(t, h, "DELETE", member, `{"version":`+version+`}`), 400, "invalid_input")
	}
	for _, body := range []string{`{"version":1,"role":"member"}`, `{"version":1,"role":"member","expectedUserId":null}`, `{"version":1,"role":"member","expectedUserId":42}`} {
		assertProjectError(t, membershipCall(t, h, "PATCH", member, body), 400, "invalid_input")
	}
	for _, body := range []string{`{"version":1}`, `{"version":1,"expectedUserId":null}`, `{"version":1,"expectedUserId":42}`} {
		assertProjectError(t, membershipCall(t, h, "DELETE", member, body), 400, "invalid_input")
	}
	request := h.request("POST", base+"/invitations", `{}`)
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
}

func TestMembershipHTTPAuthenticationAndMethodRefusals(t *testing.T) {
	h := newHTTPHarness(t)
	t.Cleanup(func() { h.assertCalls(map[string]int{}) })
	base := "/api/v1/projects/" + h.Project.ID
	for _, path := range []string{"/api/v1/invitations/inspect", "/api/v1/invitations/accept"} {
		for _, method := range []string{"GET", "HEAD"} {
			response := membershipCall(t, h, method, path, invitationBody("secret"))
			if response.Code != 405 || response.Header().Get("Allow") != "POST" {
				t.Fatalf("method refusal: %d %v", response.Code, response.Header())
			}
		}
	}
	for _, origin := range [][]string{{}, {""}, {"null"}, {"https://foreign.test"}, {h.Auth.Origin(), h.Auth.Origin()}} {
		request := h.request("POST", base+"/invitations", `{}`)
		request.Header.Del("Origin")
		if len(origin) > 0 {
			request.Header["Origin"] = origin
		}
		response := httptest.NewRecorder()
		h.Handler.ServeHTTP(response, request)
		assertProjectError(t, response, 403, "forbidden")
	}
	request := h.request("GET", base+"/members", "")
	request.Header.Del("Cookie")
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	assertProjectError(t, response, 401, "unauthenticated")
	request = h.request("GET", base+"/members", "")
	request.Header.Set("Authorization", "Bearer invalid")
	response = httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	assertProjectError(t, response, 401, "unauthenticated")
}

func TestMembershipHTTPEmptyListsAndExistingInspection(t *testing.T) {
	for _, invitations := range []bool{false, true} {
		t.Run(fmt.Sprint(invitations), func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, h.Project.ID)
			path := "/api/v1/projects/" + h.Project.ID
			if invitations {
				path += "/invitations"
				h.Memberships.ListInvitationsFunc = func(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
					check(ctx, p, id)
					return nil, nil
				}
			} else {
				path += "/members"
				h.Memberships.ListWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
					check(ctx, p, id)
					return coreproject.ProjectParticipants{ActorAccess: membershipAccess(h, nil)}, nil
				}
			}
			response := membershipCall(t, h, "GET", path, "")
			if response.Code != 200 || !strings.Contains(response.Body.String(), `"items":[]`) {
				t.Fatalf("empty list: %d %s", response.Code, response.Body)
			}
		})
	}
	h := newHTTPHarness(t)
	check := membershipExpectation(t, h, "")
	grant := membershipGrant(h, 8, model.ProjectAdmin)
	access := membershipAccess(h, &grant)
	h.Memberships.InspectInvitationFunc = func(ctx context.Context, p model.Principal, token string) (coreproject.InvitationInspection, error) {
		check(ctx, p, "")
		if token != "existing" {
			t.Fatalf("token=%q", token)
		}
		return coreproject.InvitationInspection{ProjectID: h.Project.ID, ProjectName: h.Project.Name, DirectGrant: &grant, Access: &access}, nil
	}
	response := membershipCall(t, h, "POST", "/api/v1/invitations/inspect", invitationBody("existing"))
	value := decodeResponse[api.ProjectInvitationInspection](t, response, 200)
	if value.DirectGrant == nil || value.DirectGrant.Role != "admin" || value.Access == nil || value.Access.EffectiveRole != "admin" {
		t.Fatalf("existing inspection: %+v", value)
	}
}

func TestMembershipHTTPInvitationUnavailable(t *testing.T) {
	for _, action := range []string{"inspect", "accept"} {
		t.Run(action, func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, "")
			failure := model.InvitationUnavailable(errors.New("private invitation lookup"))
			body := invitationBody("bad")
			if action == "inspect" {
				h.Memberships.InspectInvitationFunc = func(ctx context.Context, p model.Principal, token string) (coreproject.InvitationInspection, error) {
					check(ctx, p, "")
					if token != "bad" {
						t.Fatalf("token=%q", token)
					}
					return coreproject.InvitationInspection{}, failure
				}
			} else {
				body = invitationAcceptBody("bad", h.Principal.UserID)
				h.Memberships.AcceptInvitationFunc = func(ctx context.Context, p model.Principal, token, expected string) (coreproject.InvitationAcceptance, error) {
					check(ctx, p, "")
					if token != "bad" || expected != p.UserID {
						t.Fatalf("accept=%q %q", token, expected)
					}
					return coreproject.InvitationAcceptance{}, failure
				}
			}
			assertProjectError(t, membershipCall(t, h, "POST", "/api/v1/invitations/"+action, body), 404, "invitation_unavailable")
		})
	}
}

func TestMembershipHTTPBearerReadsAndWrites(t *testing.T) {
	for _, method := range []string{"GET", "PATCH"} {
		t.Run(method, func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, h.Project.ID)
			authCalls := 0
			h.AuthenticateFunc = func(ctx context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
				authCalls++
				if kind != model.PATCredential || secret != "private-pat-credential" || ctx.Value(membershipContextKey{}) != t {
					t.Fatalf("credential: %q %q", kind, secret)
				}
				return h.Principal, nil
			}
			path := "/api/v1/projects/" + h.Project.ID + "/members"
			body := ""
			if method == "GET" {
				h.Memberships.ListWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
					check(ctx, p, id)
					return coreproject.ProjectParticipants{ActorAccess: membershipAccess(h, nil)}, nil
				}
			} else {
				path += "/" + h.Principal.UserID
				body = memberRoleBody(t, 12, "member", h.Principal.UserID)
				h.Memberships.SetRoleFunc = func(ctx context.Context, p model.Principal, id, user string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
					check(ctx, p, id)
					if user != p.UserID || input != (coreproject.SetProjectMemberRole{Version: 12, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}) {
						t.Fatalf("PAT mutation: %q %+v", user, input)
					}
					return membershipGrant(h, 12, model.ProjectMemberRole), nil
				}
			}
			request := h.request(method, path, body)
			request = request.WithContext(context.WithValue(request.Context(), membershipContextKey{}, t))
			request.Header.Del("Cookie")
			request.Header.Set("Origin", "https://foreign.test")
			request.Header.Set("Authorization", "Bearer private-pat-credential")
			response := httptest.NewRecorder()
			h.Handler.ServeHTTP(response, request)
			if response.Code != 200 || authCalls != 1 || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || strings.Contains(h.Logs.String(), "private-pat-credential") {
				t.Fatalf("PAT response: %d %s authCalls=%d logs=%s", response.Code, response.Body, authCalls, &h.Logs)
			}
		})
	}
}

func TestMembershipHTTPForwardsBusinessValidationInputs(t *testing.T) {
	for _, entry := range []struct {
		name, method, target, role, expected, code string
		status                                     int
	}{
		{"role_identity", "PATCH", "", "admin", "00000000-0000-4000-8000-000000000075", "identity_mismatch", 409},
		{"remove_identity", "DELETE", "", "", "00000000-0000-4000-8000-000000000075", "identity_mismatch", 409},
		{"role_actor_format", "PATCH", "", "member", "invalid", "invalid_input", 400},
		{"remove_actor_format", "DELETE", "", "", "invalid", "invalid_input", 400},
		{"role_target_format", "PATCH", "bad", "admin", "", "invalid_input", 400},
		{"remove_target_format", "DELETE", "bad", "", "", "invalid_input", 400},
		{"unknown_role", "PATCH", "", "owner", "", "invalid_input", 400},
	} {
		t.Run(entry.name, func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, h.Project.ID)
			target, expected := entry.target, entry.expected
			if target == "" {
				target = h.Principal.UserID
			}
			if expected == "" {
				expected = h.Principal.UserID
			}
			failure := &model.Fault{Code: entry.code, Message: "Invalid project member operation."}
			body := memberRemovalBody(t, 17, expected)
			if entry.method == "PATCH" {
				body = memberRoleBody(t, 17, entry.role, expected)
				h.Memberships.SetRoleFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
					check(ctx, p, project)
					if user != target || input != (coreproject.SetProjectMemberRole{Version: 17, Role: model.ProjectRole(entry.role), ExpectedUserID: expected}) {
						t.Fatalf("business input: %q %+v", user, input)
					}
					return model.ProjectGrant{}, failure
				}
			} else {
				h.Memberships.RemoveFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.RemoveProjectMember) error {
					check(ctx, p, project)
					if user != target || input != (coreproject.RemoveProjectMember{Version: 17, ExpectedUserID: expected}) {
						t.Fatalf("business input: %q %+v", user, input)
					}
					return failure
				}
			}
			response := membershipCall(t, h, entry.method, "/api/v1/projects/"+h.Project.ID+"/members/"+target, body)
			assertProjectError(t, response, entry.status, entry.code)
			if response.Header().Get("Daynight-User-ID") != h.Principal.UserID {
				t.Fatal("business refusal lost authenticated principal")
			}
		})
	}
}
