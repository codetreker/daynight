package server

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestThreadHTTPAuthenticationAndExecutionAttribution(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t), identityBrowser(t)
	integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	integration.login(t, outsider, "nullable")
	origin := map[string]string{"Origin": integration.server.URL}
	request := func(browser *http.Client, method, path string, body any, headers map[string]string, status int, code string) (*http.Response, []byte) {
		t.Helper()
		text := ""
		if body != nil {
			text = jsonBody(t, body)
		}
		response, data := identityRequest(t, browser, method, integration.server.URL+path, text, headers, status)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("authenticated Thread resource is cacheable")
		}
		if code != "" && identityDecode[api.ErrorResponse](t, data).Error.Code != code {
			t.Fatalf("Thread refusal: %s", data)
		}
		return response, data
	}
	_, data := request(admin, http.MethodPost, "/api/v1/projects", map[string]any{"name": "Thread authentication", "repoUrl": "https://example.com/thread-auth"}, origin, 201, "")
	project := identityDecode[api.Project](t, data)
	_, data = request(admin, http.MethodPost, "/api/v1/projects/"+project.ID+"/invitations", map[string]any{}, origin, 201, "")
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("missing invitation token")
	}
	identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, 200)
	_, data = request(member, http.MethodPost, taskCollection(project.ID), map[string]any{"title": "Thread owner"}, origin, 201, "")
	task := identityDecode[api.Task](t, data)
	path := threadPath(task)
	body := map[string]any{"body": "Explicit authenticated discussion"}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodDelete} {
		request(anonymous, method, path, body, nil, 401, func() string {
			if method == http.MethodHead {
				return ""
			}
			return "unauthenticated"
		}())
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		request(outsider, method, path, body, origin, 403, "forbidden")
	}
	request(member, http.MethodPost, path, body, map[string]string{"Origin": "https://foreign.example"}, 403, "forbidden")
	_, data = request(member, http.MethodPost, "/api/v1/me/tokens", map[string]any{"name": "Thread PAT", "expiresAt": nil}, origin, 201, "")
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	_, data = request(anonymous, http.MethodPost, path, body, bearer, 201, "")
	plain := identityDecode[api.ThreadMessage](t, data)
	if plain.Author.UserID != memberUser.ID || plain.Author.Agent || plain.Author.Execution != nil {
		t.Fatal("PAT author was not derived from authenticated account")
	}
	_, data = request(member, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, origin, 200, "")
	task = identityDecode[api.Task](t, data)
	claim := workerClaimBody(task.Version)
	_, data = request(anonymous, http.MethodPost, taskPath(task)+"/worker-claim", claim, bearer, 200, "")
	task = identityDecode[api.Task](t, data)
	body["claimId"] = claim["claimId"]
	request(admin, http.MethodPost, path, body, origin, 403, "forbidden")
	_, data = request(anonymous, http.MethodPost, path, body, bearer, 201, "")
	agent := identityDecode[api.ThreadMessage](t, data)
	if !agent.Author.Agent || agent.Author.UserID != memberUser.ID || agent.Author.Execution != nil {
		t.Fatal("default author resource exposed details or lost Agent marker")
	}
	response, data := request(anonymous, http.MethodGet, path+"?details=true", nil, bearer, 200, "")
	if response.Header.Get("Daynight-User-ID") != memberUser.ID {
		t.Fatal("Thread response lost authenticated identity header")
	}
	page := identityDecode[api.ThreadPage](t, data)
	if len(page.Items) != 2 || page.Items[0].Author.Execution != nil || page.Items[1].Author.Execution == nil || page.Items[1].Author.Execution.ClaimID != claim["claimId"] || page.Items[1].Author.Execution.WorkerID != claim["workerId"] || page.Items[1].Author.Execution.Provider != "codex" {
		t.Fatal("detailed author did not retain bounded verified execution source")
	}
	_, data = request(anonymous, http.MethodGet, taskPath(task), nil, bearer, 200, "")
	current := identityDecode[api.Task](t, data)
	if current.Version != task.Version || current.UpdatedAt != task.UpdatedAt {
		t.Fatal("posting under a claim changed Task metadata")
	}
	request(anonymous, http.MethodPost, taskPath(task)+"/worker-claim/release", map[string]any{"version": task.Version, "claimId": claim["claimId"], "stoppedConfirmed": true}, bearer, 200, "")
	request(anonymous, http.MethodPost, path, body, bearer, 409, "claim_conflict")
	_, data = request(anonymous, http.MethodGet, path+"?details=true", nil, bearer, 200, "")
	if identityDecode[api.ThreadPage](t, data).Items[1].Author.Execution.ClaimID != claim["claimId"] {
		t.Fatal("claim release changed historical author attribution")
	}
	response, data = request(anonymous, http.MethodHead, path, nil, bearer, 200, "")
	if len(data) != 0 || response.Header.Get("Content-Type") != "application/json" {
		t.Fatal("HEAD returned a body or lost response metadata")
	}
	if integration.logs.contains(token.Token) || integration.logs.contains("Explicit authenticated discussion") || strings.Contains(string(data), "Bearer") {
		t.Fatal("Thread leaked credentials or discussion to logs")
	}
}
