package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// This exercises the editor and report routes through the real service and store.
func TestWorkerPromptHTTPConfigurationSync(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	project := taskProject(t, handler)
	reportSnapshotHTTP(t, handler, workerID, workerSnapshotReportBody())
	paths := []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/" + project.ID + "/worker-prompt", "/api/v1/me/workers/" + workerID + "/prompt"}
	for i, path := range paths {
		empty := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		if empty["revision"] != "0" || empty["text"] != "" || empty["updatedAt"] != nil {
			t.Fatalf("initial resource: %#v", empty)
		}
		body := jsonBody(t, map[string]any{"expectedUserId": handler.principal.UserID, "revision": "0", "text": []string{"user", "project", "worker"}[i]})
		saved := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodPut, path, body), http.StatusOK)
		if saved["revision"] != "1" || saved["text"] != []string{"user", "project", "worker"}[i] {
			t.Fatalf("saved resource: %#v", saved)
		}
	}
	report := func(selectors string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", strings.NewReader(jsonBody(t, configurationHTTPReportBody(nil, nil))))
		authorizeResourceRequest(handler, req)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Worker-Configuration", "2")
		req.Header.Set("Daynight-Worker-Prompts", selectors)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Header().Get("Daynight-Worker-Configuration") != "2" {
			t.Fatalf("protocol response header: %v", response.Header())
		}
		return decodeResponse[map[string]any](t, response, http.StatusOK)
	}
	selectors := `[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"project","projectId":"` + project.ID + `"},"knownRevision":null},{"key":{"scope":"worker"},"knownRevision":null}]`
	got := report(selectors)
	config := got["configuration"].(map[string]any)
	values := config["prompts"].([]any)
	if len(values) != 3 {
		t.Fatalf("results: %#v", values)
	}
	for i, item := range values {
		result := item.(map[string]any)
		value := result["value"].(map[string]any)
		if result["status"] != "value" || value["revision"] != "1" || value["text"] != []string{"user", "project", "worker"}[i] {
			t.Fatalf("result %d: %#v", i, result)
		}
	}
	known := strings.ReplaceAll(selectors, `"knownRevision":null`, `"knownRevision":"1"`)
	values = report(known)["configuration"].(map[string]any)["prompts"].([]any)
	for _, item := range values {
		if item.(map[string]any)["status"] != "unchanged" {
			t.Fatalf("expected unchanged: %#v", item)
		}
	}
	clear := jsonBody(t, map[string]any{"expectedUserId": handler.principal.UserID, "revision": "1", "text": ""})
	saved := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodPut, paths[1], clear), http.StatusOK)
	if saved["revision"] != "2" || saved["text"] != "" {
		t.Fatalf("cleared resource: %#v", saved)
	}
	values = report(known)["configuration"].(map[string]any)["prompts"].([]any)
	projectResult := values[1].(map[string]any)
	value := projectResult["value"].(map[string]any)
	if projectResult["status"] != "value" || value["revision"] != "2" || value["text"] != "" {
		t.Fatalf("cleared result: %#v", projectResult)
	}
	mismatch := jsonBody(t, map[string]any{"expectedUserId": uuid.NewString(), "revision": "2", "text": "wrong user"})
	assertProjectError(t, projectRequest(handler, http.MethodPut, paths[1], mismatch), http.StatusConflict, "identity_mismatch")
	after := decodeResponse[map[string]json.RawMessage](t, projectRequest(handler, http.MethodGet, paths[1], ""), http.StatusOK)
	if string(after["revision"]) != `"2"` || string(after["text"]) != `""` {
		t.Fatalf("identity mismatch changed resource: %#v", after)
	}
	// Selectors do not consume the existing JSON report body budget.
	body := jsonBody(t, configurationHTTPReportBody(nil, nil))
	body += strings.Repeat(" ", 1024*1024-len(body))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", strings.NewReader(body))
	authorizeResourceRequest(handler, req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Daynight-Worker-Configuration", "2")
	req.Header.Set("Daynight-Worker-Prompts", selectors)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	decodeResponse[map[string]any](t, response, http.StatusOK)
}

func TestWorkerPromptHTTPCookieIdentityMismatch(t *testing.T) {
	integration := newIdentityIntegration(t)
	alice, bob := identityBrowser(t), identityBrowser(t)
	aliceUser := integration.login(t, alice, "alice")
	bobUser := integration.login(t, bob, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	path := integration.server.URL + "/api/v1/me/worker-prompt"
	put := func(user, revision, text string) string {
		return jsonBody(t, map[string]any{"expectedUserId": user, "revision": revision, "text": text})
	}
	identityRequest(t, alice, http.MethodPut, path, put(aliceUser.ID, "0", "Alice"), origin, http.StatusOK)
	identityRequest(t, bob, http.MethodPut, path, put(bobUser.ID, "0", "Bob"), origin, http.StatusOK)
	_, beforeAlice := identityRequest(t, alice, http.MethodGet, path, "", nil, http.StatusOK)
	_, beforeBob := identityRequest(t, bob, http.MethodGet, path, "", nil, http.StatusOK)
	response, body := identityRequest(t, bob, http.MethodPut, path, put(aliceUser.ID, "1", "Alice draft"), origin, http.StatusConflict)
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &failure); err != nil || failure.Error.Code != "identity_mismatch" || response.Header.Get("Daynight-User-ID") != bobUser.ID {
		t.Fatalf("identity mismatch: %s %v", body, err)
	}
	_, afterAlice := identityRequest(t, alice, http.MethodGet, path, "", nil, http.StatusOK)
	_, afterBob := identityRequest(t, bob, http.MethodGet, path, "", nil, http.StatusOK)
	if string(beforeAlice) != string(afterAlice) || string(beforeBob) != string(afterBob) {
		t.Fatalf("identity mismatch changed a resource: Alice %s -> %s; Bob %s -> %s", beforeAlice, afterAlice, beforeBob, afterBob)
	}
}
