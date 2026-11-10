package server

import (
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
	f.tx.WriteIdentityCall = newHTTPTestStoreForPrincipal(t, p).WriteIdentityCall
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
