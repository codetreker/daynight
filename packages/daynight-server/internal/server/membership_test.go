package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type membershipHarness struct {
	*authHarness
	admin    *http.Cookie
	member   *http.Cookie
	outsider *http.Cookie
	project  model.Project
	adminID  string
	memberID string
}

func membershipTestHarness(t *testing.T) *membershipHarness {
	t.Helper()
	h := &membershipHarness{authHarness: authTestHarness(t)}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	projecthttp.NewMembershipRoutes(projectservice.NewMemberships(h.Database), h.Auth, logger).RegisterRoutes(mux)
	h.Handler = httpx.RequestLogging(logger, mux)
	h.admin = h.Login(t, "membership-admin")
	h.member = h.Login(t, "membership-member")
	h.outsider = h.Login(t, "membership-outsider")
	principal, err := h.Identity.Authenticate(context.Background(), model.SessionCredential, h.admin.Value)
	if err != nil {
		t.Fatal(err)
	}
	h.adminID = principal.UserID
	h.project, err = projectservice.NewProjects(h.Database).Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Shared project", RepoURL: "https://example.com/shared.git"})
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
	return h.Request(method, path, body, cookies, nil, h.Origin)
}

func (h *membershipHarness) invitation(t *testing.T) (api.CreatedProjectInvitation, string) {
	t.Helper()
	response := h.call("POST", "/api/v1/projects/"+h.project.ID+"/invitations", invitationActorBody(h.adminID), h.admin)
	invitation := decodeResponse[api.CreatedProjectInvitation](t, response, 201)
	link, err := url.Parse(invitation.Link)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header().Get("Cache-Control") != "no-store" || link.Scheme+"://"+link.Host != h.Origin || link.Path != "/invitations" || link.RawQuery != "" || link.Fragment == "" || response.Header().Get("Location") != "/api/v1/projects/"+h.project.ID+"/invitations/"+invitation.ID {
		t.Fatalf("invitation disclosure: %d %+v", response.Code, invitation)
	}
	if invitation.CreatedBy != h.adminID || invitation.ExpiresAt.Sub(invitation.CreatedAt) != 7*24*time.Hour || invitation.ConsumedAt != nil || invitation.RevokedAt != nil {
		t.Fatalf("invitation metadata: %+v", invitation)
	}
	var stored []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM project_invitations WHERE id=$1`, invitation.ID).Scan(&stored); err != nil {
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
