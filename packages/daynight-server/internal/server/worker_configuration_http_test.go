package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func configurationHTTPValue() map[string]any {
	return map[string]any{
		"maxConcurrent": 3, "pollIntervalMs": 60000, "recoveryLimit": 0, "preferPlatformSpecificTasks": false,
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
	f := newConfigurationHTTPFixture(t, io.Discard)
	value := configurationHTTPValue()
	missing := f.read(t, model.WorkerConfigurationResource{}, model.ErrNotFound, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	assertProjectError(t, missing, http.StatusNotFound, "not_found")
	f.report(t, model.WorkerConfigurationResource{}, workerSnapshotReportBody(), nil, nil, nil, nil, http.StatusOK, "")
	uninitialized := model.WorkerConfigurationResource{ObservationRevision: "0"}
	response := f.read(t, uninitialized, nil, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	resource := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
	fields := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
	if len(fields) != 3 || string(fields["desired"]) != "null" || string(fields["observation"]) != "null" || string(fields["observationRevision"]) != `"0"` || resource.Desired != nil || resource.Observation != nil || response.Header().Get(workerConfigurationHeader) != "1" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatalf("legacy worker configuration must be explicitly uninitialized: %s", response.Body)
	}
	f.put(t, uninitialized, configurationHTTPModel(t, value), "1", nil, nil, http.StatusConflict, "configuration_not_initialized")
	response = f.invalidRevision(t, "0", configurationHTTPModel(t, value), func() *httptest.ResponseRecorder {
		return projectRequest(f.handler, http.MethodPut, f.path(), jsonBody(t, map[string]any{"revision": "0", "value": value}))
	})
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	projectID := "d4444444-4444-4444-8444-444444444444"
	value["projects"] = []any{map[string]any{"projectId": strings.ToUpper(projectID), "nativeOverrides": map[string]any{"model": nil, "args": []any{}}}}
	value["preferPlatformSpecificTasks"] = true
	canonical := configurationHTTPModel(t, value)
	canonical.Projects[0].ProjectID = projectID
	initial := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: canonical}
	exchange := &model.WorkerConfigurationExchange{Bootstrap: &canonical}
	body := configurationHTTPReportBody(value, nil)
	receipt := f.report(t, uninitialized, body, exchange, &initial, nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(receipt.Configuration.Desired, &initial) || receipt.Configuration.ObservationRevision != "0" || receipt.Configuration.ObservationAccepted {
		t.Fatalf("bootstrap receipt: %+v", receipt)
	}
	overrides := receipt.Configuration.Desired.Value.Projects[0].NativeOverrides
	if receipt.Configuration.Desired.Value.Projects[0].ProjectID != projectID || string(overrides["model"]) != "null" || string(overrides["args"]) != "[]" {
		t.Fatalf("explicit native override intent was lost: %+v", receipt.Configuration.Desired.Value.Projects[0])
	}
	current := model.WorkerConfigurationResource{Desired: &initial, ObservationRevision: "0"}
	value["maxConcurrent"] = 5
	value["preferPlatformSpecificTasks"] = false
	changed := configurationHTTPModel(t, value)
	changed.Projects[0].ProjectID = projectID
	saved := model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: f.now.Add(time.Second), Value: changed}
	resource = f.put(t, current, changed, "1", &saved, nil, http.StatusOK, "")
	if !reflect.DeepEqual(resource.Desired, &saved) || !resource.Desired.UpdatedAt.After(initial.UpdatedAt) {
		t.Fatalf("target change did not advance revision: %+v", resource.Desired)
	}
	current = model.WorkerConfigurationResource{Desired: &saved, ObservationRevision: "0"}
	resource = f.put(t, current, changed, "2", nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(resource, current) {
		t.Fatal("equal canonical configuration changed its revision or timestamp")
	}
	f.put(t, current, changed, "1", nil, nil, http.StatusConflict, "version_conflict")
	staleBootstrap := configurationHTTPValue()
	staleBootstrap["maxConcurrent"] = 9
	stale := configurationHTTPModel(t, staleBootstrap)
	receipt = f.report(t, current, configurationHTTPReportBody(staleBootstrap, nil), &model.WorkerConfigurationExchange{Bootstrap: &stale}, nil, nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(receipt.Configuration.Desired, &saved) {
		t.Fatal("repeated bootstrap overwrote the cloud target")
	}
	f.report(t, current, workerSnapshotReportBody(), nil, nil, nil, nil, http.StatusOK, "")
	f.get(t, current)
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
	f := newConfigurationHTTPFixture(t, io.Discard)
	value := configurationHTTPValue()
	canonical := configurationHTTPModel(t, value)
	initial := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: canonical}
	current := model.WorkerConfigurationResource{ObservationRevision: "0"}
	f.report(t, current, configurationHTTPReportBody(value, nil), &model.WorkerConfigurationExchange{Bootstrap: &canonical}, &initial, nil, nil, http.StatusOK, "")
	current.Desired = &initial
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
	exchange := configurationHTTPExchange(t, map[string]any{"bootstrap": nil, "observation": observation})
	reportedAt := f.now.Add(time.Second)
	f.now = reportedAt
	accepted := model.WorkerConfigurationResource{Desired: &initial, ObservationRevision: "1", Observation: &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: *exchange.Observation, ReportedAt: reportedAt}}
	receipt := f.report(t, current, configurationHTTPReportBody(nil, observation), exchange, nil, nil, &accepted, http.StatusOK, "")
	if !receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" {
		t.Fatalf("initial observation CAS: %+v", receipt.Configuration)
	}
	resource := f.get(t, accepted)
	if resource.Observation == nil || len(resource.Observation.Items) != 7 || resource.Observation.Items[4].Error == nil || resource.Observation.Items[5].Key.ProjectID != removedID {
		t.Fatalf("partial success and project removal results were lost: %+v", resource.Observation)
	}
	response := f.read(t, accepted, nil, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	if !configurationHTTPObservationReportedAt(t, response).Equal(reportedAt) {
		t.Fatal("configuration observation server time was lost")
	}
	value["maxConcurrent"] = 4
	changed := configurationHTTPModel(t, value)
	desired := model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: f.now.Add(2 * time.Second), Value: changed}
	f.put(t, accepted, changed, "1", &desired, nil, http.StatusOK, "")
	f.now = desired.UpdatedAt
	current = model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "1", Observation: accepted.Observation}
	stale := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 1))
	receipt = f.report(t, current, configurationHTTPReportBody(nil, stale), configurationHTTPExchange(t, map[string]any{"bootstrap": nil, "observation": stale}), nil, nil, nil, http.StatusOK, "")
	if receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" || !reflect.DeepEqual(receipt.Configuration.Desired, &desired) {
		t.Fatalf("stale observation did not return current target and CAS: %+v", receipt.Configuration)
	}
	f.report(t, current, workerSnapshotReportBody(), nil, nil, nil, nil, http.StatusOK, "")
	f.get(t, current)
	response = f.read(t, current, nil, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	if !configurationHTTPObservationReportedAt(t, response).Equal(reportedAt) {
		t.Fatal("stale observation or machine heartbeat replaced configuration observation")
	}
	fresh := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 4))
	fresh["baseRevision"], fresh["desiredRevision"] = "1", "2"
	fresh["items"].([]any)[0].(map[string]any)["targetRevision"] = "2"
	freshExchange := configurationHTTPExchange(t, map[string]any{"bootstrap": nil, "observation": fresh})
	final := model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "2", Observation: &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: *freshExchange.Observation, ReportedAt: f.now.Add(3 * time.Second)}}
	f.now = final.Observation.ReportedAt
	receipt = f.report(t, current, configurationHTTPReportBody(nil, fresh), freshExchange, nil, nil, &final, http.StatusOK, "")
	if !receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "2" {
		t.Fatalf("fresh observation CAS: %+v", receipt.Configuration)
	}
	response = f.read(t, final, nil, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	if !configurationHTTPObservationReportedAt(t, response).After(reportedAt) {
		t.Fatal("newly accepted observation did not advance its server report time")
	}
}

func TestWorkerConfigurationHTTPStrictInputAndNegotiation(t *testing.T) {
	f := newConfigurationHTTPFixture(t, io.Discard)
	handler, workerID := f.handler, f.workerID
	path := "/api/v1/me/workers/" + workerID
	value := configurationHTTPValue()
	canonical := configurationHTTPModel(t, value)
	desired := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: canonical}
	f.report(t, model.WorkerConfigurationResource{ObservationRevision: "0"}, configurationHTTPReportBody(value, nil), &model.WorkerConfigurationExchange{Bootstrap: &canonical}, &desired, nil, nil, http.StatusOK, "")
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
		var response *httptest.ResponseRecorder
		if text, ok := revision.(string); ok {
			response = f.invalidRevision(t, text, configurationHTTPModel(t, value), func() *httptest.ResponseRecorder {
				return projectRequest(handler, http.MethodPut, path+"/configuration", jsonBody(t, map[string]any{"revision": revision, "value": value}))
			})
		} else {
			response = projectRequest(handler, http.MethodPut, path+"/configuration", jsonBody(t, map[string]any{"revision": revision, "value": value}))
		}
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
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
	resource := f.get(t, model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "0"})
	if resource.Desired.Revision != "1" || resource.ObservationRevision != "0" || resource.Observation != nil {
		t.Fatal("invalid requests changed the configuration")
	}
}

func TestWorkerConfigurationHTTPResourceAdmission(t *testing.T) {
	f := newConfigurationHTTPFixture(t, io.Discard)
	value := configurationHTTPModel(t, configurationHTTPValue())
	desired := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: value}
	current := model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "0"}
	f.report(t, model.WorkerConfigurationResource{ObservationRevision: "0"}, configurationHTTPReportBody(configurationHTTPValue(), nil), &model.WorkerConfigurationExchange{Bootstrap: &value}, &desired, nil, nil, http.StatusOK, "")
	server := httptest.NewServer(f.handler)
	t.Cleanup(server.Close)
	var head *http.Response
	f.readScope(t, current, nil, func() {
		request := httptest.NewRequest(http.MethodHead, server.URL+f.path(), nil)
		request.RequestURI = ""
		authorizeResourceRequest(f.handler, request)
		var err error
		head, err = server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
	})
	data, readErr := io.ReadAll(head.Body)
	closeErr := head.Body.Close()
	if readErr != nil || closeErr != nil || head.StatusCode != http.StatusOK || len(data) != 0 || head.Header.Get("Content-Type") != "application/json" || head.Header.Get(workerConfigurationHeader) != "1" || head.Header.Get("Cache-Control") != "no-store" || head.Header.Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatalf("configuration HEAD admission: %d %v %s", head.StatusCode, head.Header, data)
	}
	for _, target := range []string{f.path() + "?", f.path() + "?unknown=value", "/api/v1/me/workers/not-uuid/configuration"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			assertProjectError(t, projectRequest(f.handler, method, target, `{}`), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(f.handler, method, f.path(), "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD, PUT" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
			t.Fatal("configuration method error lost its allowed methods or private admission headers")
		}
	}
}

func TestWorkerConfigurationHTTPIdentityOriginAndRevokedProjects(t *testing.T) {
	var logs bytes.Buffer
	f := newConfigurationHTTPFixture(t, &logs)
	origin := configuredTestConfig().PublicOrigin
	value := configurationHTTPModel(t, configurationHTTPValue())
	putBody := func(revision string) string {
		return jsonBody(t, map[string]any{"revision": revision, "value": configurationHTTPLegacyValue(t, value)})
	}
	f.headers = http.Header{}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		assertProjectError(t, f.request(method, f.path(), putBody("1")), http.StatusUnauthorized, "unauthenticated")
	}
	alice := defaultHTTPPrincipal()
	alice.Kind = model.SessionCredential
	bob := model.Principal{UserID: "e5555555-5555-4555-8555-555555555555", CredentialID: "f6666666-6666-4666-8666-666666666666", Kind: model.SessionCredential}
	cookieHeaders := func(site string) http.Header {
		return http.Header{"Cookie": {"__Host-daynight_session=" + httpTestToken(model.SessionCredential)}, "Origin": {site}}
	}
	f.actor(t, alice, cookieHeaders(origin))
	uninitialized := model.WorkerConfigurationResource{ObservationRevision: "0"}
	f.report(t, uninitialized, workerSnapshotReportBody(), nil, nil, nil, nil, http.StatusOK, "")
	projectID := "d4444444-4444-4444-8444-444444444444"
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{}}}
	bootstrap := &model.WorkerConfigurationExchange{Bootstrap: &value}
	f.report(t, uninitialized, configurationHTTPReportBody(configurationHTTPLegacyValue(t, value), nil), bootstrap, nil, model.ErrNotFound, nil, http.StatusNotFound, "not_found")
	f.get(t, uninitialized)
	initial := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: value}
	f.report(t, uninitialized, configurationHTTPReportBody(configurationHTTPLegacyValue(t, value), nil), bootstrap, &initial, nil, nil, http.StatusOK, "")
	current := model.WorkerConfigurationResource{Desired: &initial, ObservationRevision: "0"}
	f.actor(t, bob, cookieHeaders(origin))
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		var response *httptest.ResponseRecorder
		if method == http.MethodGet {
			response = f.read(t, model.WorkerConfigurationResource{}, model.ErrNotFound, func() *httptest.ResponseRecorder { return f.request(method, f.path(), putBody("1")) })
		} else {
			response = f.putResult(t, value, "1", model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "Worker was not found."}, func() *httptest.ResponseRecorder {
				return f.request(method, f.path(), putBody("1"))
			})
		}
		assertProjectError(t, response, http.StatusNotFound, "not_found")
		if response.Header().Get("Daynight-User-ID") != bob.UserID || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cross-owner configuration error lost authenticated admission")
		}
	}
	for _, invalidOrigin := range []string{"", "null", "https://foreign.example"} {
		f.actor(t, alice, cookieHeaders(invalidOrigin))
		assertProjectError(t, f.request(http.MethodPut, f.path(), putBody("1")), http.StatusForbidden, "forbidden")
	}
	alice.Kind = model.PATCredential
	f.actor(t, alice, http.Header{"Authorization": {"Bearer " + defaultHTTPToken()}, "Origin": {"https://foreign.example"}, "Daynight-User-ID": {bob.UserID}})
	f.put(t, current, value, "1", nil, nil, http.StatusOK, "")
	alice.Kind = model.SessionCredential
	f.actor(t, alice, cookieHeaders(origin))
	value.MaxConcurrent = 4
	second := model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: f.now.Add(time.Second), Value: value}
	resource := f.put(t, current, value, "1", &second, nil, http.StatusOK, "")
	if resource.Desired.Revision != "2" || len(resource.Desired.Value.Projects) != 1 || len(resource.Desired.Value.Projects[0].NativeOverrides) != 0 || strings.Contains(jsonBody(t, resource), "Private configuration project") || strings.Contains(jsonBody(t, resource), "private-configuration-repository") {
		t.Fatal("retaining a revoked project blocked unrelated settings or exposed project details")
	}
	current = model.WorkerConfigurationResource{Desired: &second, ObservationRevision: "0"}
	changed := value
	changed.Projects = []model.WorkerProjectConfiguration{{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage("null")}}}
	f.put(t, current, changed, "2", nil, model.ErrNotFound, http.StatusNotFound, "not_found")
	removed := value
	removed.Projects = []model.WorkerProjectConfiguration{}
	third := model.WorkerDesiredConfiguration{Revision: "3", UpdatedAt: f.now.Add(2 * time.Second), Value: removed}
	resource = f.put(t, current, removed, "2", &third, nil, http.StatusOK, "")
	if resource.Desired.Revision != "3" || len(resource.Desired.Value.Projects) != 0 {
		t.Fatal("revoked project could not be removed")
	}
	current = model.WorkerConfigurationResource{Desired: &third, ObservationRevision: "0"}
	f.put(t, current, value, "3", nil, model.ErrNotFound, http.StatusNotFound, "not_found")
	if strings.Contains(logs.String(), defaultHTTPToken()) || strings.Contains(logs.String(), httpTestToken(model.SessionCredential)) || strings.Contains(logs.String(), "private-configuration-repository") {
		t.Fatal("configuration requests leaked credentials or private repository details to logs")
	}
}
