package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type configurationHTTPFixture struct {
	*workerHTTPFixture
	workerID string
	headers  http.Header
}

func newConfigurationHTTPFixture(t *testing.T, output io.Writer) *configurationHTTPFixture {
	t.Helper()
	return &configurationHTTPFixture{workerHTTPFixture: newWorkerHTTPFixture(t, output), workerID: "c3333333-3333-4333-8333-333333333333", headers: http.Header{"Authorization": {"Bearer " + defaultHTTPToken()}}}
}

func (f *configurationHTTPFixture) request(method, path, body string, versions ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header = f.headers.Clone()
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	for _, version := range versions {
		request.Header.Add(workerConfigurationHeader, version)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func (f *configurationHTTPFixture) actor(t *testing.T, p model.Principal, headers http.Header) {
	t.Helper()
	f.handler.principal = p
	f.handler.authenticate = true
	f.headers = headers
}

func configurationHTTPModel(t *testing.T, value any) model.WorkerConfiguration {
	t.Helper()
	var result model.WorkerConfiguration
	if err := json.Unmarshal([]byte(jsonBody(t, value)), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func configurationHTTPLegacyValue(t *testing.T, value model.WorkerConfiguration) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, value)), &result); err != nil {
		t.Fatal(err)
	}
	delete(result, "agentControlMode")
	delete(result, "toolPaths")
	return result
}

func configurationHTTPExchange(t *testing.T, value any) *model.WorkerConfigurationExchange {
	t.Helper()
	var result model.WorkerConfigurationExchange
	if err := json.Unmarshal([]byte(jsonBody(t, value)), &result); err != nil {
		t.Fatal(err)
	}
	return &result
}

func configurationHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("configuration DAO arguments: got %#v, want %#v", actual, expected)
		panic("configuration DAO arguments differ")
	}
}

func configurationHTTPCopy[T any](t *testing.T, value T) T {
	t.Helper()
	return workerHTTPValue[T](t, value)
}

func configurationHTTPCalls(t *testing.T, expected []string) (func(string), func()) {
	t.Helper()
	var actual []string
	var mu sync.Mutex
	return func(name string) {
			mu.Lock()
			defer mu.Unlock()
			actual = append(actual, name)
			if len(actual) > len(expected) || actual[len(actual)-1] != expected[len(actual)-1] {
				t.Errorf("configuration DAO calls = %v, want %v", actual, expected)
				panic("extra or out-of-order configuration DAO call")
			}
		}, func() {
			t.Helper()
			mu.Lock()
			defer mu.Unlock()
			configurationHTTPCheck(t, actual, expected)
		}
}

func (f *configurationHTTPFixture) path() string {
	return "/api/v1/me/workers/" + f.workerID + "/configuration"
}

func (f *configurationHTTPFixture) readScope(t *testing.T, current model.WorkerConfigurationResource, failure error, request func()) {
	t.Helper()
	called, verify := configurationHTTPCalls(t, []string{"snapshot", "configuration"})
	f.tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		called("snapshot")
		return op(&workerHTTPReadScope{t: t, DAO: &workerHTTPReader{t: t, WorkerConfigurationCall: func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
			called("configuration")
			configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
			return configurationHTTPCopy(t, current), failure
		}}})
	}
	request()
	verify()
	f.tx.ReadSnapshotCall = nil
}

func (f *configurationHTTPFixture) read(t *testing.T, current model.WorkerConfigurationResource, failure error, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	var result *httptest.ResponseRecorder
	f.readScope(t, current, failure, func() { result = request() })
	return result
}

func (f *configurationHTTPFixture) get(t *testing.T, current model.WorkerConfigurationResource) model.WorkerConfigurationResource {
	t.Helper()
	response := f.read(t, current, nil, func() *httptest.ResponseRecorder { return f.request(http.MethodGet, f.path(), "") })
	result := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
	configurationHTTPCheck(t, result, current)
	return result
}

func (f *configurationHTTPFixture) put(t *testing.T, current model.WorkerConfigurationResource, value model.WorkerConfiguration, revision string, saved *model.WorkerDesiredConfiguration, accessIDs []string, accessFailure error, status int, code string) model.WorkerConfigurationResource {
	t.Helper()
	want := []string{"write", "configuration"}
	for range accessIDs {
		want = append(want, "access")
	}
	if saved != nil {
		want = append(want, "desired")
	}
	called, verify := configurationHTTPCalls(t, want)
	dao := &workerHTTPWriteDAO{t: t, WorkerConfigurationCall: func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
		called("configuration")
		configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
		return configurationHTTPCopy(t, current), nil
	}}
	if len(accessIDs) != 0 {
		index := 0
		dao.ConfigurationProjectAccessCall = func(_ context.Context, user, project string) error {
			called("access")
			configurationHTTPCheck(t, []string{user, project}, []string{f.handler.principal.UserID, accessIDs[index]})
			index++
			return accessFailure
		}
	}
	if saved != nil {
		dao.SetWorkerConfigurationCall = func(_ context.Context, user, worker string, next int64, actual model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
			called("desired")
			configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
			configurationHTTPCheck(t, next, configurationRevisionInt(t, saved.Revision))
			configurationHTTPCheck(t, actual, value)
			return configurationHTTPCopy(t, *saved), nil
		}
	}
	f.tx.WriteWorkerCall = func(ctx context.Context, op func(store.WorkerScope) error) (store.Completion, error) {
		called("write")
		err := op(&workerHTTPWriteScope{t: t, DAO: dao})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	legacyValue := configurationHTTPLegacyValue(t, value)
	response := f.request(http.MethodPut, f.path(), jsonBody(t, map[string]any{"revision": revision, "value": legacyValue}))
	verify()
	f.tx.WriteWorkerCall = nil
	if status != http.StatusOK {
		assertProjectError(t, response, status, code)
		return model.WorkerConfigurationResource{}
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID || response.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatal("configuration mutation lost private ownership or protocol headers")
	}
	return decodeResponse[model.WorkerConfigurationResource](t, response, status)
}

func configurationRevisionInt(t *testing.T, value string) int64 {
	t.Helper()
	var result int64
	if err := json.Unmarshal([]byte(value), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *configurationHTTPFixture) report(t *testing.T, current model.WorkerConfigurationResource, body map[string]any, expectedExchange *model.WorkerConfigurationExchange, saved *model.WorkerDesiredConfiguration, accessIDs []string, accessFailure error, accepted *model.WorkerConfigurationResource, status int, code string) configurationHTTPReceipt {
	t.Helper()
	var inventory *model.WorkerTaskInventory
	if err := json.Unmarshal([]byte(jsonBody(t, body["taskInventory"])), &inventory); err != nil {
		t.Fatal(err)
	}
	want := []string{"write", "admit"}
	if inventory != nil {
		want = append(want, "tasks")
	}
	want = append(want, "upsert")
	if expectedExchange != nil {
		want = append(want, "configuration")
		for range accessIDs {
			want = append(want, "access")
		}
		if saved != nil {
			want = append(want, "desired")
		}
		if accepted != nil {
			want = append(want, "observation", "configuration")
		}
	}
	if status == http.StatusOK {
		want = append(want, "observed")
	}
	called, verify := configurationHTTPCalls(t, want)
	telemetry := workerHTTPTelemetry(t, body)
	expected := model.WorkerSnapshot{UserID: f.handler.principal.UserID, WorkerID: f.workerID, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: telemetry, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
	if inventory != nil {
		expected.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventory.ObservedAt, Items: []model.WorkerObservedTask{}}
	}
	dao := &workerHTTPWriteDAO{t: t, UpsertWorkerCall: func(_ context.Context, actual model.WorkerSnapshot) (model.WorkerSnapshot, error) {
		called("upsert")
		configurationHTTPCheck(t, actual, expected)
		return configurationHTTPCopy(t, expected), nil
	}}
	if inventory != nil {
		dao.ReportTaskSnapshotsCall = func(_ context.Context, user string, actual model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
			called("tasks")
			configurationHTTPCheck(t, user, f.handler.principal.UserID)
			configurationHTTPCheck(t, actual, *inventory)
			return []store.WorkerTaskSource{}, nil
		}
	}
	configurationReads := 0
	if expectedExchange != nil {
		dao.WorkerConfigurationCall = func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
			called("configuration")
			configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
			configurationReads++
			if configurationReads == 2 {
				return configurationHTTPCopy(t, *accepted), nil
			}
			return configurationHTTPCopy(t, current), nil
		}
	}
	if len(accessIDs) != 0 {
		index := 0
		dao.ConfigurationProjectAccessCall = func(_ context.Context, user, project string) error {
			called("access")
			configurationHTTPCheck(t, []string{user, project}, []string{f.handler.principal.UserID, accessIDs[index]})
			index++
			return accessFailure
		}
	}
	if saved != nil {
		dao.SetWorkerConfigurationCall = func(_ context.Context, user, worker string, revision int64, value model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
			called("desired")
			configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
			configurationHTTPCheck(t, revision, int64(1))
			configurationHTTPCheck(t, value, *expectedExchange.Bootstrap)
			return configurationHTTPCopy(t, *saved), nil
		}
	}
	if accepted != nil {
		dao.SetWorkerConfigurationObservationCall = func(_ context.Context, user, worker string, revision int64, value model.WorkerConfigurationObservation) error {
			called("observation")
			configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
			configurationHTTPCheck(t, revision, configurationRevisionInt(t, accepted.ObservationRevision))
			configurationHTTPCheck(t, value, *expectedExchange.Observation)
			return nil
		}
	}
	scope := &workerHTTPWriteScope{t: t, DAO: dao, AdmitWorkerCall: func(_ context.Context, user, worker string, duration time.Duration) (store.WorkerAdmission, error) {
		called("admit")
		configurationHTTPCheck(t, []string{user, worker}, []string{f.handler.principal.UserID, f.workerID})
		configurationHTTPCheck(t, duration, 120*time.Second)
		return store.WorkerAdmission{ObservedAt: f.now}, nil
	}, ObservedAtCall: func(context.Context) (time.Time, error) { called("observed"); return f.now, nil }}
	f.tx.WriteWorkerCall = func(ctx context.Context, op func(store.WorkerScope) error) (store.Completion, error) {
		called("write")
		err := op(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	versions := []string(nil)
	if expectedExchange != nil {
		versions = []string{"1"}
	}
	response := f.request(http.MethodPost, "/api/v1/me/workers/"+f.workerID+"/report", jsonBody(t, body), versions...)
	verify()
	f.tx.WriteWorkerCall = nil
	if status != http.StatusOK {
		assertProjectError(t, response, status, code)
		return configurationHTTPReceipt{}
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatal("report lost private admission headers")
	}
	if expectedExchange == nil {
		fields := decodeResponse[map[string]json.RawMessage](t, response, status)
		if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || response.Header().Get(workerConfigurationHeader) != "" {
			t.Fatalf("legacy report receipt changed: %s", response.Body)
		}
		return configurationHTTPReceipt{}
	}
	if response.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatal("configuration report lost protocol header")
	}
	return decodeResponse[configurationHTTPReceipt](t, response, status)
}

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
	f.report(t, model.WorkerConfigurationResource{}, workerSnapshotReportBody(), nil, nil, nil, nil, nil, http.StatusOK, "")
	uninitialized := model.WorkerConfigurationResource{ObservationRevision: "0"}
	response := f.read(t, uninitialized, nil, func() *httptest.ResponseRecorder { return projectRequest(f.handler, http.MethodGet, f.path(), "") })
	resource := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
	fields := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
	if len(fields) != 3 || string(fields["desired"]) != "null" || string(fields["observation"]) != "null" || string(fields["observationRevision"]) != `"0"` || resource.Desired != nil || resource.Observation != nil || response.Header().Get(workerConfigurationHeader) != "1" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatalf("legacy worker configuration must be explicitly uninitialized: %s", response.Body)
	}
	f.put(t, uninitialized, configurationHTTPModel(t, value), "1", nil, nil, nil, http.StatusConflict, "configuration_not_initialized")
	assertProjectError(t, projectRequest(f.handler, http.MethodPut, f.path(), jsonBody(t, map[string]any{"revision": "0", "value": value})), http.StatusBadRequest, "invalid_input")
	projectID := "d4444444-4444-4444-8444-444444444444"
	value["projects"] = []any{map[string]any{"projectId": strings.ToUpper(projectID), "nativeOverrides": map[string]any{"model": nil, "args": []any{}}}}
	value["preferPlatformSpecificTasks"] = true
	canonical := configurationHTTPModel(t, value)
	canonical.Projects[0].ProjectID = projectID
	initial := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: canonical}
	exchange := &model.WorkerConfigurationExchange{Bootstrap: &canonical}
	body := configurationHTTPReportBody(value, nil)
	receipt := f.report(t, uninitialized, body, exchange, &initial, []string{projectID}, nil, nil, http.StatusOK, "")
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
	resource = f.put(t, current, changed, "1", &saved, nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(resource.Desired, &saved) || !resource.Desired.UpdatedAt.After(initial.UpdatedAt) {
		t.Fatalf("target change did not advance revision: %+v", resource.Desired)
	}
	current = model.WorkerConfigurationResource{Desired: &saved, ObservationRevision: "0"}
	resource = f.put(t, current, changed, "2", nil, nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(resource, current) {
		t.Fatal("equal canonical configuration changed its revision or timestamp")
	}
	f.put(t, current, changed, "1", nil, nil, nil, http.StatusConflict, "version_conflict")
	staleBootstrap := configurationHTTPValue()
	staleBootstrap["maxConcurrent"] = 9
	stale := configurationHTTPModel(t, staleBootstrap)
	receipt = f.report(t, current, configurationHTTPReportBody(staleBootstrap, nil), &model.WorkerConfigurationExchange{Bootstrap: &stale}, nil, nil, nil, nil, http.StatusOK, "")
	if !reflect.DeepEqual(receipt.Configuration.Desired, &saved) {
		t.Fatal("repeated bootstrap overwrote the cloud target")
	}
	f.report(t, current, workerSnapshotReportBody(), nil, nil, nil, nil, nil, http.StatusOK, "")
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
	f.report(t, current, configurationHTTPReportBody(value, nil), &model.WorkerConfigurationExchange{Bootstrap: &canonical}, &initial, nil, nil, nil, http.StatusOK, "")
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
	receipt := f.report(t, current, configurationHTTPReportBody(nil, observation), exchange, nil, nil, nil, &accepted, http.StatusOK, "")
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
	f.put(t, accepted, changed, "1", &desired, nil, nil, http.StatusOK, "")
	f.now = desired.UpdatedAt
	current = model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "1", Observation: accepted.Observation}
	stale := configurationHTTPObservation(configurationHTTPItem("maxConcurrent", 1))
	receipt = f.report(t, current, configurationHTTPReportBody(nil, stale), configurationHTTPExchange(t, map[string]any{"bootstrap": nil, "observation": stale}), nil, nil, nil, nil, http.StatusOK, "")
	if receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" || !reflect.DeepEqual(receipt.Configuration.Desired, &desired) {
		t.Fatalf("stale observation did not return current target and CAS: %+v", receipt.Configuration)
	}
	f.report(t, current, workerSnapshotReportBody(), nil, nil, nil, nil, nil, http.StatusOK, "")
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
	receipt = f.report(t, current, configurationHTTPReportBody(nil, fresh), freshExchange, nil, nil, nil, &final, http.StatusOK, "")
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
	f.report(t, model.WorkerConfigurationResource{ObservationRevision: "0"}, configurationHTTPReportBody(value, nil), &model.WorkerConfigurationExchange{Bootstrap: &canonical}, &desired, nil, nil, nil, http.StatusOK, "")
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
	f.report(t, model.WorkerConfigurationResource{ObservationRevision: "0"}, configurationHTTPReportBody(configurationHTTPValue(), nil), &model.WorkerConfigurationExchange{Bootstrap: &value}, &desired, nil, nil, nil, http.StatusOK, "")
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
	origin := workerTestOrigin
	value := configurationHTTPModel(t, configurationHTTPValue())
	putBody := func(revision string) string {
		return jsonBody(t, map[string]any{"revision": revision, "value": configurationHTTPLegacyValue(t, value)})
	}
	f.headers = http.Header{}
	f.handler.authenticate = false
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
	f.report(t, uninitialized, workerSnapshotReportBody(), nil, nil, nil, nil, nil, http.StatusOK, "")
	projectID := "d4444444-4444-4444-8444-444444444444"
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{}}}
	bootstrap := &model.WorkerConfigurationExchange{Bootstrap: &value}
	f.report(t, uninitialized, configurationHTTPReportBody(configurationHTTPLegacyValue(t, value), nil), bootstrap, nil, []string{projectID}, model.ErrNotFound, nil, http.StatusNotFound, "not_found")
	f.get(t, uninitialized)
	initial := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: f.now, Value: value}
	f.report(t, uninitialized, configurationHTTPReportBody(configurationHTTPLegacyValue(t, value), nil), bootstrap, &initial, []string{projectID}, nil, nil, http.StatusOK, "")
	current := model.WorkerConfigurationResource{Desired: &initial, ObservationRevision: "0"}
	f.actor(t, bob, cookieHeaders(origin))
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		var response *httptest.ResponseRecorder
		if method == http.MethodGet {
			response = f.read(t, model.WorkerConfigurationResource{}, model.ErrNotFound, func() *httptest.ResponseRecorder { return f.request(method, f.path(), putBody("1")) })
		} else {
			called, verify := configurationHTTPCalls(t, []string{"write", "configuration"})
			dao := &workerHTTPWriteDAO{t: t, WorkerConfigurationCall: func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
				called("configuration")
				configurationHTTPCheck(t, []string{user, worker}, []string{bob.UserID, f.workerID})
				return model.WorkerConfigurationResource{}, model.ErrNotFound
			}}
			f.tx.WriteWorkerCall = func(ctx context.Context, op func(store.WorkerScope) error) (store.Completion, error) {
				called("write")
				return store.Completion{Outcome: store.TransactionNotCommitted}, op(&workerHTTPWriteScope{t: t, DAO: dao})
			}
			response = f.request(method, f.path(), putBody("1"))
			verify()
			f.tx.WriteWorkerCall = nil
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
	f.put(t, current, value, "1", nil, nil, nil, http.StatusOK, "")
	alice.Kind = model.SessionCredential
	f.actor(t, alice, cookieHeaders(origin))
	value.MaxConcurrent = 4
	second := model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: f.now.Add(time.Second), Value: value}
	resource := f.put(t, current, value, "1", &second, nil, nil, http.StatusOK, "")
	if resource.Desired.Revision != "2" || len(resource.Desired.Value.Projects) != 1 || len(resource.Desired.Value.Projects[0].NativeOverrides) != 0 || strings.Contains(jsonBody(t, resource), "Private configuration project") || strings.Contains(jsonBody(t, resource), "private-configuration-repository") {
		t.Fatal("retaining a revoked project blocked unrelated settings or exposed project details")
	}
	current = model.WorkerConfigurationResource{Desired: &second, ObservationRevision: "0"}
	changed := value
	changed.Projects = []model.WorkerProjectConfiguration{{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage("null")}}}
	f.put(t, current, changed, "2", nil, []string{projectID}, model.ErrNotFound, http.StatusNotFound, "not_found")
	removed := value
	removed.Projects = []model.WorkerProjectConfiguration{}
	third := model.WorkerDesiredConfiguration{Revision: "3", UpdatedAt: f.now.Add(2 * time.Second), Value: removed}
	resource = f.put(t, current, removed, "2", &third, nil, nil, http.StatusOK, "")
	if resource.Desired.Revision != "3" || len(resource.Desired.Value.Projects) != 0 {
		t.Fatal("revoked project could not be removed")
	}
	current = model.WorkerConfigurationResource{Desired: &third, ObservationRevision: "0"}
	f.put(t, current, value, "3", nil, []string{projectID}, model.ErrNotFound, http.StatusNotFound, "not_found")
	if strings.Contains(logs.String(), defaultHTTPToken()) || strings.Contains(logs.String(), httpTestToken(model.SessionCredential)) || strings.Contains(logs.String(), "private-configuration-repository") {
		t.Fatal("configuration requests leaked credentials or private repository details to logs")
	}
}
