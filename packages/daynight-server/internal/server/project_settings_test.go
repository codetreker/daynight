package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func settingsPath(projectID string) string {
	return "/api/v1/projects/" + projectID + "/settings"
}

func TestProjectSettingsHTTPVersionsAndConsistentProjections(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project, other := taskProject(t, handler), taskProject(t, handler)
	if project.Settings != (api.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) || other.Settings != project.Settings {
		t.Fatalf("new project settings: %+v, %+v", project, other)
	}
	save := func(version int64, minutes int32) api.Project {
		t.Helper()
		response := projectRequest(handler, http.MethodPatch, settingsPath(strings.ToUpper(project.ID)), jsonBody(t, map[string]any{"version": version, "executionWarningMinutes": minutes}))
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("project settings mutation can be cached")
		}
		return decodeResponse[api.Project](t, response, http.StatusOK)
	}
	if unchanged := save(1, 60); unchanged != project {
		t.Fatalf("current-version same-value save changed project metadata: %+v", unchanged)
	}
	updated := save(1, 90)
	preserved := updated
	preserved.Settings, preserved.UpdatedAt = project.Settings, project.UpdatedAt
	if updated.Settings != (api.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}) || !updated.UpdatedAt.After(project.UpdatedAt) || preserved != project {
		t.Fatalf("settings update did not preserve identity or advance its revision: %+v", updated)
	}
	if unchanged := save(2, 90); unchanged != updated {
		t.Fatal("same-value settings save changed the version or update timestamp")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, settingsPath(project.ID), `{"version":1,"executionWarningMinutes":90}`), http.StatusConflict, "version_conflict")
	if read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID, ""), http.StatusOK); read != updated {
		t.Fatal("stale same-value save changed authoritative settings")
	}

	const exact int64 = 9_007_199_254_740_993
	if _, err := database.Pool.Exec(context.Background(), "UPDATE projects SET settings_version=$1 WHERE id=$2", exact, project.ID); err != nil {
		t.Fatal(err)
	}
	exactRead := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID, "")
	if !strings.Contains(exactRead.Body.String(), `"version":9007199254740993`) {
		t.Fatal("project response rounded its nested settings version")
	}
	updated = save(exact, 2147483647)
	if updated.Settings.Version != exact+1 || updated.Settings.ExecutionWarningMinutes != 2147483647 {
		t.Fatalf("settings endpoint lost an exact int64 version or positive int32 boundary: %+v", updated.Settings)
	}
	if unchanged := save(exact+1, 2147483647); unchanged != updated {
		t.Fatal("exact-version no-op mutated the project")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, settingsPath(project.ID), `{"version":9007199254740993,"executionWarningMinutes":2147483647}`), http.StatusConflict, "version_conflict")
	updated = save(exact+1, 1)
	if updated.Settings != (api.ProjectSettings{Version: exact + 2, ExecutionWarningMinutes: 1}) {
		t.Fatalf("minimum supported warning threshold failed: %+v", updated.Settings)
	}

	read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID, ""), http.StatusOK)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID), ""), http.StatusOK)
	if read != updated || graph.Project != updated || len(page.Items) != 2 || page.Items[0] != updated || page.Items[1] != other {
		t.Fatalf("settings differ across project/get/list/graph resources: project %+v, page %+v, graph %+v", read, page, graph.Project)
	}
	if readOther := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+other.ID, ""), http.StatusOK); readOther != other {
		t.Fatal("saving one project's settings changed another project")
	}
	for _, fragment := range []string{`"component":"project"`, `"phase":"settings"`, `"request_id":"project-test"`, `"project_id":"` + project.ID + `"`, `"user_id":"` + handler.principal.UserID + `"`, `"route":"PATCH /api/v1/projects/{projectId}/settings"`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("project settings diagnostic lost %s", fragment)
		}
	}
}

func TestProjectSettingsHTTPStrictInputsAndMethods(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	path := settingsPath(project.ID)
	for _, body := range []string{
		"", "null", "[]", `"value"`, `true`, `{`, `{"version":`, `{"version":1,}`, `{"version":1} {}`, `{}`,
		`{"version":1}`, `{"executionWarningMinutes":60}`,
		`{"version":null,"executionWarningMinutes":60}`, `{"version":0,"executionWarningMinutes":60}`,
		`{"version":-1,"executionWarningMinutes":60}`, `{"version":"1","executionWarningMinutes":60}`,
		`{"version":true,"executionWarningMinutes":60}`, `{"version":[],"executionWarningMinutes":60}`,
		`{"version":{},"executionWarningMinutes":60}`, `{"version":1.0,"executionWarningMinutes":60}`,
		`{"version":1e0,"executionWarningMinutes":60}`, `{"version":9223372036854775808,"executionWarningMinutes":60}`,
		`{"version":1,"executionWarningMinutes":null}`, `{"version":1,"executionWarningMinutes":0}`,
		`{"version":1,"executionWarningMinutes":-1}`, `{"version":1,"executionWarningMinutes":"60"}`,
		`{"version":1,"executionWarningMinutes":true}`, `{"version":1,"executionWarningMinutes":[]}`,
		`{"version":1,"executionWarningMinutes":{}}`, `{"version":1,"executionWarningMinutes":1.0}`,
		`{"version":1,"executionWarningMinutes":1e0}`, `{"version":1,"executionWarningMinutes":2147483648}`,
		`{"version":1,"version":1,"executionWarningMinutes":60}`,
		`{"version":1,"ver\u0073ion":1,"executionWarningMinutes":60}`,
		`{"version":1,"executionWarningMinutes":60,"executionWarningMinutes":60}`,
		`{"version":1,"executionWarningMinutes":60,"executionWarningMinut\u0065s":60}`,
		`{"Version":1,"executionWarningMinutes":60}`, `{"version":1,"ExecutionWarningMinutes":60}`,
		`{"version":1,"executionWarningMinutes":60,"settings":{"version":1}}`,
		`{"version":1,"executionWarningMinutes":60,"updatedAt":"2026-01-01T00:00:00Z"}`,
		`{"version":1,"executionWarningMinutes":60,"unknown":"private-settings-body-secret"}`,
		"{\"version\":1,\"executionWarningMinutes\":60,\"unknown\":\"" + string([]byte{0xff}) + "\"}",
		`{"version":1,"executionWarningMinutes":60,"unknown":"` + strings.Repeat("x", maxJSONBody) + `"}`,
	} {
		t.Run(body[:min(len(body), 80)], func(t *testing.T) {
			response := projectRequest(handler, http.MethodPatch, path, body)
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("invalid settings response can be cached")
			}
		})
	}
	for _, query := range []string{"", "version=1", "unknown=secret-query", "x=1&x=2", "x=%xx", "x=1;y=2", "&", "="} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, path+"?"+query, `{"version":1,"executionWarningMinutes":90}`), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, path, `{"version":1,"executionWarningMinutes":90}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "PATCH" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("settings method contract: %+v", response.Header())
		}
	}
	for _, contentType := range []string{"", "text/plain", "application/json; charset=iso-8859-1", "application/json; charset=", "application/json; charset=utf-8; charset=us-ascii"} {
		request := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(`{"version":1,"executionWarningMinutes":90}`))
		authorizeResourceRequest(handler, request)
		request.Header.Set("Content-Type", contentType)
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, settingsPath("private-invalid-project-secret"), `{"version":1,"executionWarningMinutes":90}`), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, settingsPath("00000000-0000-4000-8000-000000000099"), `{"version":1,"executionWarningMinutes":90}`), http.StatusNotFound, "not_found")
	if read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID, ""), http.StatusOK); read != project {
		t.Fatal("rejected settings input changed the project")
	}
	for _, secret := range []string{"private-settings-body-secret", "secret-query", "private-invalid-project-secret", handler.token} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("project settings diagnostics exposed request content or credentials")
		}
	}
}

func TestProjectSettingsHTTPAuthenticationAndProjectRoles(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t), identityBrowser(t)
	adminUser := integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	integration.login(t, outsider, "nullable")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects", `{"name":"Project settings authorization","repoUrl":"https://example.com/settings"}`, origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects/"+project.ID+"/invitations", `{}`, origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("project invitation omitted its acceptance token")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, http.StatusOK)
	if joined := identityDecode[api.ProjectMember](t, data); joined.UserID != memberUser.ID || joined.Role != "member" {
		t.Fatalf("ordinary project member fixture: %+v", joined)
	}
	request := func(browser *http.Client, method, path, body string, headers map[string]string, status int, code string) []byte {
		t.Helper()
		response, value := identityRequest(t, browser, method, integration.server.URL+path, body, headers, status)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("settings authentication or resource response can be cached")
		}
		if code != "" && identityDecode[api.ErrorResponse](t, value).Error.Code != code {
			t.Fatalf("settings refusal lost its domain code: %s", value)
		}
		return value
	}
	path := settingsPath(project.ID)
	body := `{"version":1,"executionWarningMinutes":90}`
	request(anonymous, http.MethodPatch, path, body, nil, http.StatusUnauthorized, "unauthenticated")
	request(anonymous, http.MethodDelete, path, body, nil, http.StatusUnauthorized, "unauthenticated")
	request(outsider, http.MethodPatch, path, body, origin, http.StatusNotFound, "not_found")
	request(member, http.MethodPatch, path, body, origin, http.StatusForbidden, "forbidden")
	for _, invalidOrigin := range []string{"", "null", "https://foreign.example"} {
		request(admin, http.MethodPatch, path, body, map[string]string{"Origin": invalidOrigin}, http.StatusForbidden, "forbidden")
	}
	if read := identityDecode[api.Project](t, request(member, http.MethodGet, "/api/v1/projects/"+project.ID, "", nil, http.StatusOK, "")); read != project {
		t.Fatal("ordinary member cannot read the saved project threshold or a refusal mutated it")
	}
	request(outsider, http.MethodGet, "/api/v1/projects/"+project.ID, "", nil, http.StatusNotFound, "not_found")
	data = request(admin, http.MethodPatch, path, body, map[string]string{"Origin": integration.server.URL, "X-Request-ID": "settings-admin-cookie"}, http.StatusOK, "")
	updated := identityDecode[api.Project](t, data)
	if updated.Settings.Version != 2 || updated.Settings.ExecutionWarningMinutes != 90 {
		t.Fatalf("administrator settings write failed: %+v", updated)
	}
	if read := identityDecode[api.Project](t, request(member, http.MethodGet, "/api/v1/projects/"+project.ID, "", nil, http.StatusOK, "")); read != updated {
		t.Fatal("saved settings did not reach another authorized client")
	}
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Settings administrator","expiresAt":null}`, origin, http.StatusCreated)
	adminToken := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, adminToken.Token)
	data = request(anonymous, http.MethodPatch, path, `{"version":2,"executionWarningMinutes":95}`, map[string]string{"Authorization": "Bearer " + adminToken.Token, "Origin": "https://foreign.example", "X-Request-ID": "settings-admin-pat"}, http.StatusOK, "")
	updated = identityDecode[api.Project](t, data)
	if updated.Settings.Version != 3 || updated.Settings.ExecutionWarningMinutes != 95 {
		t.Fatalf("administrator PAT could not save settings: %+v", updated)
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Read settings","expiresAt":null}`, origin, http.StatusCreated)
	memberToken := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, memberToken.Token)
	memberHeaders := map[string]string{"Authorization": "Bearer " + memberToken.Token}
	request(anonymous, http.MethodPatch, path, `{"version":3,"executionWarningMinutes":10}`, memberHeaders, http.StatusForbidden, "forbidden")
	if read := identityDecode[api.Project](t, request(anonymous, http.MethodGet, "/api/v1/projects/"+project.ID, "", memberHeaders, http.StatusOK, "")); read != updated {
		t.Fatal("member PAT could not read authoritative settings or changed them")
	}
	identityRequest(t, admin, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+adminToken.ID, "", origin, http.StatusNoContent)
	request(anonymous, http.MethodPatch, path, `{"version":3,"executionWarningMinutes":10}`, map[string]string{"Authorization": "Bearer " + adminToken.Token}, http.StatusUnauthorized, "unauthenticated")
	if read := identityDecode[api.Project](t, request(member, http.MethodGet, "/api/v1/projects/"+project.ID, "", nil, http.StatusOK, "")); !reflect.DeepEqual(read, updated) {
		t.Fatal("rejected member or revoked-token save changed project settings")
	}
	integration.logs.mu.Lock()
	logs := integration.logs.buffer.String()
	integration.logs.mu.Unlock()
	for _, requestID := range []string{"settings-admin-cookie", "settings-admin-pat"} {
		matched := false
		for line := range strings.SplitSeq(logs, "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil && entry["component"] == "project" && entry["phase"] == "settings" && entry["request_id"] == requestID && entry["project_id"] == project.ID && entry["user_id"] == adminUser.ID {
				matched = true
			}
		}
		if !matched {
			t.Fatalf("settings mutation lost administrator/request/project correlation: %s", requestID)
		}
	}
	for _, secret := range integration.secrets {
		if secret != "" && strings.Contains(logs, secret) {
			t.Fatal("settings diagnostics exposed authentication credentials")
		}
	}
}
