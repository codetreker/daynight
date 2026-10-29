package server

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func TestWorkerSnapshotsHTTPIdentityOriginAndCurrentPermissions(t *testing.T) {
	integration := newIdentityIntegration(t)
	alice, bob, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	aliceUser := integration.login(t, alice, "alice")
	integration.login(t, bob, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	identityRequest(t, anonymous, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, body), nil, http.StatusUnauthorized)
	identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, body), map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden)
	response, _ := identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, body), origin, http.StatusOK)
	if response.Header.Get("Daynight-User-ID") != aliceUser.ID || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("worker response identity headers missing")
	}
	identityRequest(t, bob, http.MethodGet, integration.server.URL+path, "", nil, http.StatusNotFound)
	_, data := identityRequest(t, bob, http.MethodGet, integration.server.URL+"/api/v1/me/workers", "", nil, http.StatusOK)
	if len(identityDecode[api.WorkerPage](t, data).Items) != 0 {
		t.Fatal("other account worker leaked")
	}
	identityRequest(t, anonymous, http.MethodGet, integration.server.URL+path, "", nil, http.StatusUnauthorized)
	_, data = identityRequest(t, alice, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Worker snapshots","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, token.Token)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	response, _ = identityRequest(t, anonymous, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, body), bearer, http.StatusOK)
	if response.Header.Get("Daynight-User-ID") != aliceUser.ID {
		t.Fatal("PAT reporter ownership was not authenticated")
	}
	_, data = identityRequest(t, bob, http.MethodPost, integration.server.URL+"/api/v1/projects", `{"name":"Private project","repoUrl":"https://example.com/snapshot"}`, origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	_, data = identityRequest(t, bob, http.MethodPost, integration.server.URL+"/api/v1/projects/"+project.ID+"/invitations", `{}`, origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil {
		t.Fatal(err)
	}
	identityRequest(t, alice, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, http.StatusOK)
	_, data = identityRequest(t, alice, http.MethodPost, integration.server.URL+taskCollection(project.ID), `{"title":"Hidden after revoke"}`, origin, http.StatusCreated)
	task := identityDecode[api.Task](t, data)
	_, data = identityRequest(t, alice, http.MethodPatch, integration.server.URL+taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "allowAgents": true}), origin, http.StatusOK)
	task = identityDecode[api.Task](t, data)
	claim := workerClaimBody(task.Version)
	claim["workerId"] = id
	_, data = identityRequest(t, alice, http.MethodPost, integration.server.URL+taskPath(task)+"/worker-claim", jsonBody(t, claim), origin, http.StatusOK)
	task = identityDecode[api.Task](t, data)
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": project.ID, "taskId": task.ID, "claimId": task.Properties.Worker.ClaimID}}}
	identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, body), origin, http.StatusOK)
	_, data = identityRequest(t, alice, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
	if detail := identityDecode[api.WorkerDetailResponse](t, data); len(detail.Worker.Tasks) != 1 || detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 1 {
		t.Fatal("current member task missing")
	}
	_, data = identityRequest(t, bob, http.MethodGet, integration.server.URL+"/api/v1/projects/"+project.ID+"/members", "", nil, http.StatusOK)
	members := identityDecode[api.ProjectMemberList](t, data)
	var membershipVersion int64
	for _, member := range members.Items {
		if member.UserID == aliceUser.ID {
			membershipVersion = member.Version
		}
	}
	if membershipVersion == 0 {
		t.Fatal("observed member missing before revocation")
	}
	identityRequest(t, bob, http.MethodDelete, integration.server.URL+"/api/v1/projects/"+project.ID+"/members/"+aliceUser.ID, jsonBody(t, map[string]any{"version": membershipVersion}), origin, http.StatusNoContent)
	_, data = identityRequest(t, alice, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
	if detail := identityDecode[api.WorkerDetailResponse](t, data); len(detail.Worker.Tasks) != 0 || detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 0 || strings.Contains(string(data), "Hidden after revoke") {
		t.Fatal("revoked task row, title or count leaked")
	}
	_, data = identityRequest(t, alice, http.MethodGet, integration.server.URL+"/api/v1/me/workers", "", nil, http.StatusOK)
	if page := identityDecode[api.WorkerPage](t, data); len(page.Items) != 1 || page.Items[0].ActiveTaskCount == nil || *page.Items[0].ActiveTaskCount != 0 {
		t.Fatal("revoked task count leaked through worker summary")
	}
	if integration.logs.contains(token.Token) || integration.logs.contains("Private worker machine") || integration.logs.contains("/private/work") || integration.logs.contains("Hidden after revoke") {
		t.Fatal("report metadata or credentials leaked to logs")
	}
}
