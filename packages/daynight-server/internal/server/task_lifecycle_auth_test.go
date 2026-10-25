package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskLifecycleAuthenticationAndMemberAccess(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t), identityBrowser(t)
	integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	integration.login(t, outsider, "nullable")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects",
		`{"name":"Lifecycle authorization","repoUrl":"https://example.com/lifecycle"}`, origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+taskCollection(project.ID), `{"title":"Completed external prerequisite"}`, origin, http.StatusCreated)
	prerequisite := identityDecode[api.Task](t, data)
	for _, action := range []string{"in_progress", "done"} {
		_, data = identityRequest(t, admin, http.MethodPut, integration.server.URL+taskPath(prerequisite)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: prerequisite.Version, Status: action}), origin, http.StatusOK)
		prerequisite = identityDecode[api.Task](t, data)
	}
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects/"+project.ID+"/invitations", `{}`, origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("project invitation did not contain an acceptance token")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, http.StatusOK)
	if joined := identityDecode[api.ProjectMember](t, data); joined.UserID != memberUser.ID || joined.Role != "member" {
		t.Fatalf("invitation did not grant the ordinary member role: %+v", joined)
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+taskCollection(project.ID),
		jsonBody(t, map[string]any{"title": "Member workflow", "description": "Original", "dependsOn": []string{prerequisite.ID}, "externalDependsOn": []string{prerequisite.ID}}), origin, http.StatusCreated)
	task := identityDecode[api.Task](t, data)
	_, data = identityRequest(t, member, http.MethodPatch, integration.server.URL+taskPath(task),
		jsonBody(t, map[string]any{"version": task.Version, "description": "Revised by a member", "allowAgents": true}), origin, http.StatusOK)
	task = identityDecode[api.Task](t, data)
	if !task.AllowAgents {
		t.Fatal("ordinary member could not enable automatic execution")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Member lifecycle","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	integration.secrets = append(integration.secrets, token.Token)

	request := func(t *testing.T, browser *http.Client, method, path, body string, headers map[string]string, status int, code string) []byte {
		t.Helper()
		response, data := identityRequest(t, browser, method, integration.server.URL+path, body, headers, status)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("lifecycle response can be cached: %s %s", method, path)
		}
		if code != "" && identityDecode[api.ErrorResponse](t, data).Error.Code != code {
			t.Fatalf("lifecycle refusal changed error code: %s", data)
		}
		return data
	}
	body := jsonBody(t, map[string]any{"version": task.Version, "allowAgents": false})
	request(t, anonymous, http.MethodPatch, taskPath(task), body, nil, http.StatusUnauthorized, "unauthenticated")
	request(t, outsider, http.MethodPatch, taskPath(task), body, origin, http.StatusNotFound, "not_found")
	request(t, member, http.MethodPatch, taskPath(task), body, map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden, "forbidden")
	data = request(t, anonymous, http.MethodPatch, taskPath(task), body, bearer, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	if task.AllowAgents {
		t.Fatal("member PAT could not disable permission")
	}
	classification := jsonBody(t, map[string]any{"version": task.Version, "externalDependsOn": []string{}})
	request(t, anonymous, http.MethodPatch, taskPath(task), classification, nil, http.StatusUnauthorized, "unauthenticated")
	request(t, outsider, http.MethodPatch, taskPath(task), classification, origin, http.StatusNotFound, "not_found")
	request(t, member, http.MethodPatch, taskPath(task), classification, map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden, "forbidden")
	data = request(t, anonymous, http.MethodPatch, taskPath(task), classification, bearer, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	if len(task.ExternalDependsOn) != 0 || len(task.DependsOn) != 1 {
		t.Fatal("member PAT could not change classification independently of prerequisites")
	}
	data = request(t, member, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "externalDependsOn": []string{prerequisite.ID}}), origin, http.StatusOK, "")
	task = identityDecode[api.Task](t, data)
	for _, step := range []struct{ action, status string }{{"in_progress", "in_progress"}, {"todo", "todo"}, {"done", "done"}} {
		t.Run(step.action, func(t *testing.T) {
			path := taskPath(task) + "/status"
			body := jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: step.status})
			request(t, anonymous, http.MethodPut, path, body, nil, http.StatusUnauthorized, "unauthenticated")
			request(t, anonymous, http.MethodDelete, path, body, nil, http.StatusUnauthorized, "unauthenticated")
			request(t, member, http.MethodPut, path, body, map[string]string{"Origin": "https://foreign.example"}, http.StatusForbidden, "forbidden")
			request(t, outsider, http.MethodPut, path, body, origin, http.StatusNotFound, "not_found")
			data := request(t, member, http.MethodGet, taskPath(task), "", nil, http.StatusOK, "")
			if observed := identityDecode[api.Task](t, data); !reflect.DeepEqual(observed, task) {
				t.Fatal("rejected lifecycle request changed the member's task")
			}
			browser, headers := member, map[string]string{"Origin": integration.server.URL}
			if step.action == "in_progress" || step.action == "todo" {
				browser, headers = anonymous, map[string]string{"Authorization": bearer["Authorization"]}
			}
			headers["X-Request-ID"] = "lifecycle-member-" + step.action
			data = request(t, browser, http.MethodPut, path, body, headers, http.StatusOK, "")
			changed := identityDecode[api.Task](t, data)
			if changed.Status != step.status || changed.Version != task.Version+1 || changed.AllowAgents != task.AllowAgents || len(changed.ExternalDependsOn) != 1 || changed.ExternalDependsOn[0] != prerequisite.ID {
				t.Fatalf("ordinary member could not perform %s: %+v", step.action, changed)
			}
			task = changed
		})
	}

	mainURL, err := url.Parse(integration.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var session string
	for _, cookie := range member.Jar.Cookies(mainURL) {
		if cookie.Name == integration.sessionCookie {
			session = cookie.String()
		}
	}
	if session == "" {
		t.Fatal("member login did not establish a browser session")
	}
	identityRequest(t, member, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+token.ID, "", origin, http.StatusNoContent)
	identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/auth/logout", "", origin, http.StatusNoContent)
	for _, action := range []string{"todo", "in_progress", "done"} {
		path := taskPath(task) + "/status"
		body := jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: action})
		request(t, anonymous, http.MethodPut, path, body, bearer, http.StatusUnauthorized, "unauthenticated")
		request(t, anonymous, http.MethodPut, path, body, map[string]string{"Cookie": session, "Origin": integration.server.URL}, http.StatusUnauthorized, "unauthenticated")
	}
	_, data = identityRequest(t, admin, http.MethodGet, integration.server.URL+taskPath(task), "", nil, http.StatusOK)
	if persisted := identityDecode[api.Task](t, data); !reflect.DeepEqual(persisted, task) {
		t.Fatal("revoked credentials changed the persisted lifecycle state")
	}
	integration.logs.mu.Lock()
	logs := integration.logs.buffer.String()
	integration.logs.mu.Unlock()
	for _, action := range []string{"todo", "in_progress", "done"} {
		found := false
		for line := range strings.SplitSeq(logs, "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil && entry["component"] == "task" && entry["phase"] == "set_status" &&
				entry["request_id"] == "lifecycle-member-"+action && entry["user_id"] == memberUser.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s did not log its authenticated member and request ID", action)
		}
	}
	for _, secret := range integration.secrets {
		if secret != "" && strings.Contains(logs, secret) {
			t.Fatal("lifecycle diagnostics exposed an authentication credential")
		}
	}
}
