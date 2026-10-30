package server

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestWorkerHTTPAuthenticatedOwnerAndWithdrawal(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t), identityBrowser(t)
	adminUser := integration.login(t, admin, "alice")
	integration.login(t, member, "bob")
	integration.login(t, outsider, "nullable")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects", `{"name":"Worker authorization","repoUrl":"https://example.com/worker"}`, origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects/"+project.ID+"/invitations", `{}`, origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("project invitation did not contain an acceptance token")
	}
	identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, http.StatusOK)
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Worker owner","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, token.Token)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	request := func(browser *http.Client, method, path string, body any, headers map[string]string, status int, code string) []byte {
		t.Helper()
		response, data := identityRequest(t, browser, method, integration.server.URL+path, jsonBody(t, body), headers, status)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("worker action response can be cached")
		}
		if code != "" && identityDecode[api.ErrorResponse](t, data).Error.Code != code {
			t.Fatalf("unexpected worker refusal code: %s", data)
		}
		return data
	}
	data = request(member, http.MethodPost, taskCollection(project.ID), map[string]any{"title": "Owned execution"}, origin, http.StatusCreated, "")
	task := identityDecode[api.Task](t, data)
	data = request(member, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true, "requiredPlatform": "linux"}, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	body := workerClaimBody(task.Version)
	path := taskPath(task) + "/worker-claim"
	request(anonymous, http.MethodPost, path, body, nil, http.StatusUnauthorized, "unauthenticated")
	request(outsider, http.MethodPost, path, body, origin, http.StatusNotFound, "not_found")
	request(member, http.MethodPost, path, body, map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden, "forbidden")
	data = request(anonymous, http.MethodPost, path, body, bearer, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	claim := apiWorker(t, task.Properties)
	if claim == nil || claim.UserID == adminUser.ID {
		t.Fatal("PAT claim did not derive its execution owner from authentication")
	}
	for _, action := range []struct {
		method string
		path   string
		body   map[string]any
	}{
		{http.MethodPatch, path, map[string]any{"version": task.Version, "claimId": claim.ClaimID, "phase": "executing"}},
		{http.MethodPost, path + "/release", map[string]any{"version": task.Version, "claimId": claim.ClaimID, "stoppedConfirmed": true}},
		{http.MethodPost, path + "/withdraw", map[string]any{"version": task.Version, "claimId": claim.ClaimID}},
	} {
		request(anonymous, action.method, action.path, action.body, nil, http.StatusUnauthorized, "unauthenticated")
		request(outsider, action.method, action.path, action.body, origin, http.StatusNotFound, "not_found")
		request(member, action.method, action.path, action.body, map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden, "forbidden")
	}
	request(admin, http.MethodPatch, path, map[string]any{"version": task.Version, "claimId": claim.ClaimID, "phase": "executing"}, origin, http.StatusForbidden, "forbidden")
	withdraw := map[string]any{"version": task.Version, "claimId": claim.ClaimID}
	data = request(anonymous, http.MethodPost, path+"/withdraw", withdraw, bearer, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("owner withdrawal did not reset execution and disable automatic claims")
	}
	request(member, http.MethodPatch, path, map[string]any{"version": task.Version, "claimId": claim.ClaimID, "phase": "executing"}, origin, http.StatusConflict, "claim_conflict")
	data = request(member, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	body = workerClaimBody(task.Version)
	data = request(member, http.MethodPost, path, body, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	data = request(admin, http.MethodPost, path+"/release", map[string]any{"version": task.Version, "claimId": apiWorker(t, task.Properties).ClaimID, "stoppedConfirmed": true}, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	resume := workerClaimBody(task.Version)
	resume["previousClaimId"] = apiWorker(t, task.Properties).ClaimID
	request(outsider, http.MethodPost, path+"/resume", resume, origin, http.StatusNotFound, "not_found")
	request(anonymous, http.MethodPost, path+"/resume", resume, nil, http.StatusUnauthorized, "unauthenticated")
	data = request(admin, http.MethodPost, path+"/resume", resume, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	if apiWorker(t, task.Properties).UserID != adminUser.ID || apiWorker(t, task.Properties).ClaimID != resume["claimId"] {
		t.Fatal("manual resume did not establish the authorized caller's new claim")
	}
	withdraw = map[string]any{"version": task.Version, "claimId": apiWorker(t, task.Properties).ClaimID}
	request(member, http.MethodPost, path+"/withdraw", withdraw, origin, http.StatusForbidden, "forbidden")
	data = request(admin, http.MethodPost, path+"/withdraw", withdraw, origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" {
		t.Fatal("administrator withdrawal retained ownership")
	}
	if integration.logs.contains(token.Token) || integration.logs.contains("Owned execution") || integration.logs.contains("Worker machine") {
		t.Fatal("worker authentication or execution content leaked to logs")
	}
}
