package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func configurationHTTPValue() map[string]any {
	return map[string]any{
		"maxConcurrent": 3, "pollIntervalMs": 60000, "recoveryLimit": 0,
		"native":   map[string]any{"agent": "codex", "model": nil, "args": []any{}},
		"projects": []any{},
	}
}

func configurationHTTPRequest(handler http.Handler, method, path, body string, versions ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	for _, version := range versions {
		request.Header.Add(workerConfigurationHeader, version)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func configurationHTTPReportBody(bootstrap, observation any) map[string]any {
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	body["configuration"] = map[string]any{"bootstrap": bootstrap, "observation": observation}
	return body
}

type configurationHTTPReceipt struct {
	ObservedAt     time.Time                        `json:"observedAt"`
	LastReportedAt time.Time                        `json:"lastReportedAt"`
	Configuration  model.WorkerConfigurationReceipt `json:"configuration"`
}

func configurationHTTPReport(t *testing.T, handler http.Handler, workerID string, bootstrap, observation any) configurationHTTPReceipt {
	t.Helper()
	response := configurationHTTPRequest(handler, http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", jsonBody(t, configurationHTTPReportBody(bootstrap, observation)), "1")
	if response.Header().Get(workerConfigurationHeader) != "1" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatal("configuration report lacks its protocol or private response headers")
	}
	return decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
}

func TestWorkerConfigurationHTTPLifecycleWithoutTaskPrerequisite(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID + "/configuration"
	value := configurationHTTPValue()
	assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	reportSnapshotHTTP(t, handler, workerID, workerSnapshotReportBody())
	response := projectRequest(handler, http.MethodGet, path, "")
	resource := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
	fields := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
	if len(fields) != 3 || string(fields["desired"]) != "null" || string(fields["observation"]) != "null" || string(fields["observationRevision"]) != `"0"` {
		t.Fatalf("uninitialized configuration resource schema: %s", response.Body)
	}
	if resource.Desired != nil || resource.Observation != nil || resource.ObservationRevision != "0" || response.Header().Get(workerConfigurationHeader) != "1" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatalf("legacy worker configuration must be explicitly uninitialized: %s", response.Body)
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusConflict, "configuration_not_initialized")
	assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "0", "value": value})), http.StatusBadRequest, "invalid_input")
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPWorkerTask(t, handler, project.ID, "Executing during configuration bootstrap"), map[string]any{"allowAgents": true})
	claim := workerClaimBody(task.Version)
	claim["workerId"] = workerID
	task = claimHTTPWorker(t, handler, task, claim)
	value["projects"] = []any{map[string]any{"projectId": strings.ToUpper(project.ID), "nativeOverrides": map[string]any{"model": nil, "args": []any{}}}}
	receipt := configurationHTTPReport(t, handler, workerID, value, nil)
	if receipt.Configuration.Desired == nil || receipt.Configuration.Desired.Revision != "1" || receipt.Configuration.Desired.UpdatedAt.IsZero() || receipt.Configuration.ObservationRevision != "0" || receipt.Configuration.ObservationAccepted {
		t.Fatalf("bootstrap receipt: %+v", receipt)
	}
	initial := receipt.Configuration.Desired
	overrides := initial.Value.Projects[0].NativeOverrides
	if initial.Value.Projects[0].ProjectID != project.ID || string(overrides["model"]) != "null" || string(overrides["args"]) != "[]" {
		t.Fatalf("explicit native override intent was lost: %+v", initial.Value.Projects[0])
	}
	readTask := decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskPath(task), ""), http.StatusOK)
	if !reflect.DeepEqual(readTask, task) {
		t.Fatal("configuration bootstrap changed the existing task or claim")
	}
	value["maxConcurrent"] = 5
	resource = decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusOK)
	if resource.Desired.Revision != "2" || resource.Desired.Value.MaxConcurrent != 5 || !resource.Desired.UpdatedAt.After(initial.UpdatedAt) {
		t.Fatalf("target change did not advance revision: %+v", resource.Desired)
	}
	saved := resource.Desired
	resource = decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "2", "value": value})), http.StatusOK)
	if !reflect.DeepEqual(resource.Desired, saved) {
		t.Fatal("equal canonical configuration changed its revision or timestamp")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusConflict, "version_conflict")
	staleBootstrap := configurationHTTPValue()
	staleBootstrap["maxConcurrent"] = 9
	if got := configurationHTTPReport(t, handler, workerID, staleBootstrap, nil).Configuration.Desired; !reflect.DeepEqual(got, saved) {
		t.Fatal("repeated bootstrap overwrote the cloud target")
	}
	legacy := projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", jsonBody(t, workerSnapshotReportBody()))
	fields = decodeResponse[map[string]json.RawMessage](t, legacy, http.StatusOK)
	if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || legacy.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy report receipt changed: %s", legacy.Body)
	}
	resource = decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if !reflect.DeepEqual(resource.Desired, saved) {
		t.Fatal("legacy heartbeat changed the cloud target")
	}
}

func configurationHTTPItem(kind string, value any) map[string]any {
	return map[string]any{"key": map[string]any{"kind": kind}, "targetRevision": "1", "appliedValue": value, "state": "applied", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
}

func configurationHTTPObservation(items ...any) map[string]any {
	return map[string]any{"baseRevision": "0", "desiredRevision": "1", "items": items}
}

func configurationHTTPObservationReportedAt(t *testing.T, response *httptest.ResponseRecorder) time.Time {
	t.Helper()
	resource := decodeResponse[struct {
		Observation struct {
			ReportedAt time.Time `json:"reportedAt"`
		} `json:"observation"`
	}](t, response, http.StatusOK)
	if resource.Observation.ReportedAt.IsZero() {
		t.Fatal("accepted configuration observation lacks a server report time")
	}
	return resource.Observation.ReportedAt
}

func TestWorkerConfigurationHTTPObservationCASAndHeartbeatIndependence(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID + "/configuration"
	value := configurationHTTPValue()
	configurationHTTPReport(t, handler, workerID, value, nil)
	projectID, removedID := uuid.NewString(), uuid.NewString()
	preparation := configurationHTTPItem("projectPreparation", nil)
	preparation["key"].(map[string]any)["projectId"] = projectID
	preparation["state"] = "error"
	failure := map[string]any{"code": "permission_denied", "category": "repository", "phase": "prepare", "occurredAt": "2026-10-29T00:00:00Z"}
	preparation["error"], preparation["lastFailure"], preparation["nextAttemptAt"] = failure, failure, "2026-10-29T00:00:05Z"
	removal := configurationHTTPItem("projectRemoval", true)
	removal["key"].(map[string]any)["projectId"] = removedID
	native := map[string]any{"agent": "claude", "model": nil, "args": []any{}}
	projectNative := configurationHTTPItem("projectNative", native)
	projectNative["key"].(map[string]any)["projectId"] = projectID
	observation := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 3), configurationHTTPItem("pollIntervalMs", 60000), configurationHTTPItem("recoveryLimit", 0), configurationHTTPItem("native", native), preparation, removal, projectNative)
	receipt := configurationHTTPReport(t, handler, workerID, nil, observation)
	if !receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" {
		t.Fatalf("initial observation CAS: %+v", receipt.Configuration)
	}
	resource := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if resource.Observation == nil || len(resource.Observation.Items) != 7 || resource.Observation.Items[4].Error == nil || resource.Observation.Items[5].Key.ProjectID != removedID {
		t.Fatalf("partial success and project removal results were lost: %+v", resource.Observation)
	}
	accepted := resource.Observation
	reportedAt := configurationHTTPObservationReportedAt(t, projectRequest(handler, http.MethodGet, path, ""))
	value["maxConcurrent"] = 4
	decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusOK)
	stale := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 1))
	receipt = configurationHTTPReport(t, handler, workerID, nil, stale)
	if receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" || receipt.Configuration.Desired.Revision != "2" || receipt.Configuration.Desired.Value.MaxConcurrent != 4 {
		t.Fatalf("stale observation did not return current target and CAS: %+v", receipt.Configuration)
	}
	reportSnapshotHTTP(t, handler, workerID, workerSnapshotReportBody())
	resource = decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if resource.ObservationRevision != "1" || !reflect.DeepEqual(resource.Observation, accepted) || !configurationHTTPObservationReportedAt(t, projectRequest(handler, http.MethodGet, path, "")).Equal(reportedAt) {
		t.Fatal("stale observation or machine heartbeat replaced configuration observation")
	}
	fresh := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 4))
	fresh["baseRevision"], fresh["desiredRevision"] = "1", "2"
	fresh["items"].([]any)[0].(map[string]any)["targetRevision"] = "2"
	receipt = configurationHTTPReport(t, handler, workerID, nil, fresh)
	if !receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "2" {
		t.Fatalf("fresh observation CAS: %+v", receipt.Configuration)
	}
	if !configurationHTTPObservationReportedAt(t, projectRequest(handler, http.MethodGet, path, "")).After(reportedAt) {
		t.Fatal("newly accepted observation did not advance its server report time")
	}
}

func TestWorkerConfigurationHTTPStrictInputAndNegotiation(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID
	value := configurationHTTPValue()
	configurationHTTPReport(t, handler, workerID, value, nil)
	valid := jsonBody(t, map[string]any{"revision": "1", "value": value})
	for name, body := range map[string]string{
		"unknown root":         strings.Replace(valid, `"revision":"1"`, `"revision":"1","localPath":"/private"`, 1),
		"duplicate root":       strings.Replace(valid, `"revision":"1"`, `"revision":"1","revision":"1"`, 1),
		"missing value":        `{"revision":"1"}`,
		"null value":           `{"revision":"1","value":null}`,
		"unknown native":       strings.Replace(valid, `"agent":"codex"`, `"agent":"codex","agentControlMode":"web"`, 1),
		"duplicate native":     strings.Replace(valid, `"agent":"codex"`, `"agent":"codex","agent":"codex"`, 1),
		"missing native model": strings.Replace(valid, `,"model":null`, ``, 1),
		"null args":            strings.Replace(valid, `"args":[]`, `"args":null`, 1),
		"null projects":        strings.Replace(valid, `"projects":[]`, `"projects":null`, 1),
		"fractional scalar":    strings.Replace(valid, `"maxConcurrent":3`, `"maxConcurrent":3.5`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/configuration", body), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, revision := range []any{"0", "+1", "01", " 1", "1.0", "9223372036854775808", 1, nil} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/configuration", jsonBody(t, map[string]any{"revision": revision, "value": value})), http.StatusBadRequest, "invalid_input")
	}
	for _, overrides := range []string{`null`, `{"model":false}`, `{"args":null}`, `{"agent":null}`, `{"model":null,"model":null}`, `{"repositoryRoot":"/private"}`} {
		projects := `[{"projectId":"` + uuid.NewString() + `","nativeOverrides":` + overrides + `}]`
		body := strings.Replace(valid, `"projects":[]`, `"projects":`+projects, 1)
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/configuration", body), http.StatusBadRequest, "invalid_input")
	}
	base := jsonBody(t, configurationHTTPReportBody(nil, nil))
	assertProjectError(t, configurationHTTPRequest(handler, http.MethodPost, path+"/report", base), http.StatusBadRequest, "invalid_input")
	for _, versions := range [][]string{{""}, {"0"}, {"2"}, {"1, 1"}, {"1", "1"}} {
		assertProjectError(t, configurationHTTPRequest(handler, http.MethodPost, path+"/report", base, versions...), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{jsonBody(t, workerSnapshotReportBody()), strings.Replace(base, `"configuration":{"bootstrap":null,"observation":null}`, `"configuration":null`, 1), strings.Replace(base, `"bootstrap":null`, `"bootstrap":null,"supported":true`, 1)} {
		assertProjectError(t, configurationHTTPRequest(handler, http.MethodPost, path+"/report", body, "1"), http.StatusBadRequest, "invalid_input")
	}
	observation := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 3))
	validReport := jsonBody(t, configurationHTTPReportBody(nil, observation))
	for name, body := range map[string]string{
		"noncanonical observation CAS": strings.Replace(validReport, `"baseRevision":"0"`, `"baseRevision":"00"`, 1),
		"zero desired revision":        strings.Replace(validReport, `"desiredRevision":"1"`, `"desiredRevision":"0"`, 1),
		"future item revision":         strings.Replace(validReport, `"targetRevision":"1"`, `"targetRevision":"2"`, 1),
		"null applied success":         strings.Replace(validReport, `"appliedValue":3`, `"appliedValue":null`, 1),
		"unknown item kind":            strings.Replace(validReport, `"kind":"maxConcurrent"`, `"kind":"claim"`, 1),
		"server owned timestamp":       strings.Replace(validReport, `"baseRevision":"0"`, `"baseRevision":"0","reportedAt":"2026-10-29T00:00:00Z"`, 1),
		"open error message":           strings.Replace(validReport, `"error":null`, `"error":{"code":"command_failed","category":"runtime","phase":"apply","occurredAt":"2026-10-29T00:00:00Z","message":"private output"}`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			assertProjectError(t, configurationHTTPRequest(handler, http.MethodPost, path+"/report", body, "1"), http.StatusBadRequest, "invalid_input")
		})
	}
	resource := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	if resource.Desired.Revision != "1" || resource.ObservationRevision != "0" || resource.Observation != nil {
		t.Fatal("invalid requests changed the configuration")
	}
}

func TestWorkerConfigurationHTTPResourceAdmission(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	configurationHTTPReport(t, handler, workerID, configurationHTTPValue(), nil)
	path := "/api/v1/me/workers/" + workerID + "/configuration"
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	request := httptest.NewRequest(http.MethodHead, server.URL+path, nil)
	request.RequestURI = ""
	authorizeResourceRequest(handler, request)
	head, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(head.Body)
	closeErr := head.Body.Close()
	if readErr != nil || closeErr != nil || head.StatusCode != http.StatusOK || len(data) != 0 || head.Header.Get("Content-Type") != "application/json" || head.Header.Get(workerConfigurationHeader) != "1" || head.Header.Get("Cache-Control") != "no-store" || head.Header.Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatalf("configuration HEAD admission: %d %v %s", head.StatusCode, head.Header, data)
	}
	for _, target := range []string{path + "?", path + "?unknown=value", "/api/v1/me/workers/not-uuid/configuration"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			assertProjectError(t, projectRequest(handler, method, target, `{}`), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD, PUT" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
			t.Fatal("configuration method error lost its allowed methods or private admission headers")
		}
	}
}

func TestWorkerConfigurationHTTPIdentityOriginAndRevokedProjects(t *testing.T) {
	integration := newIdentityIntegration(t)
	alice, bob, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	aliceUser := integration.login(t, alice, "alice")
	bobUser := integration.login(t, bob, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID
	value := configurationHTTPValue()
	put := func(revision string) string { return jsonBody(t, map[string]any{"revision": revision, "value": value}) }
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		identityRequest(t, anonymous, method, integration.server.URL+path+"/configuration", put("1"), nil, http.StatusUnauthorized)
	}
	identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, workerSnapshotReportBody()), origin, http.StatusOK)
	_, data := identityRequest(t, bob, http.MethodPost, integration.server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Private configuration project", RepoURL: "https://example.com/private-configuration-repository", ExpectedUserID: bobUser.ID}), origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	value["projects"] = []any{map[string]any{"projectId": project.ID, "nativeOverrides": map[string]any{}}}
	aware := map[string]string{"Origin": integration.server.URL, workerConfigurationHeader: "1"}
	identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, configurationHTTPReportBody(value, nil)), aware, http.StatusNotFound)
	_, data = identityRequest(t, alice, http.MethodGet, integration.server.URL+path+"/configuration", "", nil, http.StatusOK)
	if identityDecode[model.WorkerConfigurationResource](t, data).Desired != nil {
		t.Fatal("inaccessible project bootstrap persisted a target")
	}
	_, data = identityRequest(t, bob, http.MethodPost, integration.server.URL+"/api/v1/projects/"+project.ID+"/invitations", invitationActorBody(bobUser.ID), origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil {
		t.Fatal(err)
	}
	identityRequest(t, alice, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationAcceptBody(link.Fragment, aliceUser.ID), origin, http.StatusOK)
	identityRequest(t, alice, http.MethodPost, integration.server.URL+path+"/report", jsonBody(t, configurationHTTPReportBody(value, nil)), aware, http.StatusOK)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		response, _ := identityRequest(t, bob, method, integration.server.URL+path+"/configuration", put("1"), origin, http.StatusNotFound)
		if response.Header.Get("Daynight-User-ID") != bobUser.ID || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cross-owner configuration error lost authenticated admission")
		}
	}
	for _, invalidOrigin := range []string{"", "null", "https://foreign.example"} {
		identityRequest(t, alice, http.MethodPut, integration.server.URL+path+"/configuration", put("1"), map[string]string{"Origin": invalidOrigin}, http.StatusForbidden)
	}
	_, data = identityRequest(t, alice, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Worker configuration","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, token.Token)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token, "Origin": "https://foreign.example", "Daynight-User-ID": bobUser.ID}
	response, _ := identityRequest(t, anonymous, http.MethodPut, integration.server.URL+path+"/configuration", put("1"), bearer, http.StatusOK)
	if response.Header.Get("Daynight-User-ID") != aliceUser.ID || response.Header.Get(workerConfigurationHeader) != "1" || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("PAT configuration mutation lost admitted ownership or protocol")
	}
	_, data = identityRequest(t, bob, http.MethodGet, integration.server.URL+"/api/v1/projects/"+project.ID+"/members", "", nil, http.StatusOK)
	members := identityDecode[api.ProjectParticipantList](t, data)
	var membershipVersion int64
	for _, member := range members.Items {
		if member.UserID == aliceUser.ID {
			membershipVersion = member.DirectGrant.Version
		}
	}
	if membershipVersion == 0 {
		t.Fatal("project membership fixture was not granted")
	}
	identityRequest(t, bob, http.MethodDelete, integration.server.URL+"/api/v1/projects/"+project.ID+"/members/"+aliceUser.ID, jsonBody(t, api.RemoveProjectMemberRequest{Version: membershipVersion, ExpectedUserID: bobUser.ID}), origin, http.StatusNoContent)
	value["maxConcurrent"] = 4
	_, data = identityRequest(t, alice, http.MethodPut, integration.server.URL+path+"/configuration", put("1"), origin, http.StatusOK)
	resource := identityDecode[model.WorkerConfigurationResource](t, data)
	if resource.Desired.Revision != "2" || len(resource.Desired.Value.Projects) != 1 || len(resource.Desired.Value.Projects[0].NativeOverrides) != 0 || strings.Contains(string(data), project.Name) || strings.Contains(string(data), project.RepoURL) {
		t.Fatal("retaining a revoked project blocked unrelated settings or exposed project details")
	}
	value["projects"].([]any)[0].(map[string]any)["nativeOverrides"] = map[string]any{"model": nil}
	identityRequest(t, alice, http.MethodPut, integration.server.URL+path+"/configuration", put("2"), origin, http.StatusNotFound)
	value["projects"] = []any{}
	_, data = identityRequest(t, alice, http.MethodPut, integration.server.URL+path+"/configuration", put("2"), origin, http.StatusOK)
	resource = identityDecode[model.WorkerConfigurationResource](t, data)
	if resource.Desired.Revision != "3" || len(resource.Desired.Value.Projects) != 0 {
		t.Fatal("revoked project could not be removed")
	}
	value["projects"] = []any{map[string]any{"projectId": project.ID, "nativeOverrides": map[string]any{}}}
	identityRequest(t, alice, http.MethodPut, integration.server.URL+path+"/configuration", put("3"), origin, http.StatusNotFound)
	if integration.logs.contains(token.Token) || integration.logs.contains("private-configuration-repository") {
		t.Fatal("configuration requests leaked credentials or private repository details to logs")
	}
}
