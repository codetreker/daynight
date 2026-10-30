package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func propertyResource(t *testing.T, handler http.Handler, method, path string, body any) api.PropertyResource {
	t.Helper()
	input := ""
	if body != nil {
		input = jsonBody(t, body)
	}
	response := projectRequest(handler, method, path, input)
	result := decodeResponse[api.PropertyResource](t, response, http.StatusOK)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatalf("property response lost authentication/cache headers: %+v", response.Header())
	}
	return result
}

func TestTaskPropertyResourceSetReplaceRemoveAndVersions(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Task description stays outside property response")
	path := taskPath(task) + "/properties"
	initial := propertyResource(t, handler, http.MethodGet, path, nil)
	if initial.ProjectID != project.ID || initial.TaskID != task.ID || initial.Version != task.Version || initial.Properties == nil || len(initial.Properties) != 0 {
		t.Fatalf("initial property resource: %+v", initial)
	}
	input := `[{"url":" opaque-property-private-secret\u0000 ","title":"value"},{"url":"same","title":"second"}]`
	set := propertyResource(t, handler, http.MethodPut, path+"/pullRequests", map[string]any{"version": initial.Version, "valueText": input})
	if set.Version != initial.Version+1 || len(apiPullRequests(t, set.Properties)) != 2 || apiPullRequests(t, set.Properties)[0].URL != " opaque-property-private-secret\x00 " {
		t.Fatalf("set did not preserve original value: %+v", set)
	}
	persisted := readHTTPTask(t, handler, task)
	noop := propertyResource(t, handler, http.MethodPut, path+"/pullRequests", map[string]any{"version": set.Version, "valueText": ` [ { "title":"value", "url":" opaque-property-private-secret\u0000 " }, {"title":"second","url":"same"} ] `})
	if !reflect.DeepEqual(noop, set) || !reflect.DeepEqual(readHTTPTask(t, handler, task), persisted) {
		t.Fatal("equivalent JSON changed task or resource")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/pullRequests", jsonBody(t, map[string]any{"version": initial.Version, "valueText": input})), http.StatusConflict, "version_conflict")
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path+"/pullRequests", jsonBody(t, map[string]any{"version": initial.Version})), http.StatusConflict, "version_conflict")
	empty := propertyResource(t, handler, http.MethodPut, path+"/pullRequests", map[string]any{"version": set.Version, "valueText": "[]"})
	if _, exists := empty.Properties["pullRequests"]; !exists || apiPullRequests(t, empty.Properties) == nil || len(apiPullRequests(t, empty.Properties)) != 0 || empty.Version != set.Version+1 {
		t.Fatalf("empty value was removed: %+v", empty)
	}
	removed := propertyResource(t, handler, http.MethodDelete, path+"/pullRequests", map[string]any{"version": empty.Version})
	if _, exists := removed.Properties["pullRequests"]; exists || removed.Properties == nil || removed.Version != empty.Version+1 {
		t.Fatalf("remove did not omit key: %+v", removed)
	}
	persisted = readHTTPTask(t, handler, task)
	if len(persisted.Properties) != 0 {
		t.Fatal("full task read restored removed property")
	}
	var count int
	if err := database.Pool.QueryRow(context.Background(), "SELECT count(*) FROM task_properties WHERE task_id=$1", task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("removed row remains: %d %v", count, err)
	}
	again := propertyResource(t, handler, http.MethodDelete, path+"/pullRequests", map[string]any{"version": removed.Version})
	if !reflect.DeepEqual(again, removed) || !reflect.DeepEqual(readHTTPTask(t, handler, task), persisted) {
		t.Fatal("already-absent removal changed metadata")
	}
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path+"/pullRequests", jsonBody(t, map[string]any{"version": empty.Version})), http.StatusConflict, "version_conflict")
	if strings.Contains(logs.String(), "property-private-secret") || strings.Contains(logs.String(), "Task description stays") {
		t.Fatalf("property contents leaked: %s", &logs)
	}
}

func TestTaskPropertyResourceSchemaAuthenticationAndMethods(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	schemaPath := "/api/v1/task-properties/schema"
	response := projectRequest(handler, http.MethodGet, schemaPath, "")
	var schema struct {
		Properties map[string]struct {
			ReadOnly bool            `json:"readOnly"`
			Schema   json.RawMessage `json:"schema"`
		} `json:"properties"`
	}
	schema = decodeResponse[struct {
		Properties map[string]struct {
			ReadOnly bool            `json:"readOnly"`
			Schema   json.RawMessage `json:"schema"`
		} `json:"properties"`
	}](t, response, http.StatusOK)
	prs, hasPR := schema.Properties["pullRequests"]
	worker, hasWorker := schema.Properties["worker"]
	if !hasPR || !hasWorker || prs.ReadOnly || !worker.ReadOnly || len(prs.Schema) == 0 || len(worker.Schema) == 0 {
		t.Fatalf("invalid property catalog: %s", response.Body)
	}
	var workerSchema map[string]any
	if err := json.Unmarshal(worker.Schema, &workerSchema); err != nil {
		t.Fatal(err)
	}
	fields, ok := workerSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("worker schema does not describe its fields: %s", worker.Schema)
	}
	for _, name := range []string{"claimId", "agentControlMode", "phase", "nativeSessionId", "claimedAt"} {
		if _, exists := fields[name]; !exists {
			t.Fatalf("worker schema omits %s", name)
		}
	}
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Read values")
	path := taskPath(task) + "/properties"
	for _, target := range []string{schemaPath, path} {
		if response := projectRequest(handler, http.MethodHead, target, ""); response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("HEAD property resource: %d %s", response.Code, response.Body)
		}
	}
	for _, item := range []struct{ method, path, body string }{{"GET", schemaPath, ""}, {"GET", path, ""}, {"PUT", path + "/pullRequests", `{"version":1,"valueText":"[]"}`}, {"DELETE", path + "/pullRequests", `{"version":1}`}} {
		request := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	}
	for _, item := range []struct{ method, path, allow string }{{"POST", schemaPath, "GET"}, {"POST", path, "GET"}, {"POST", path + "/pullRequests", "PUT"}} {
		response := projectRequest(handler, item.method, item.path, `{}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if !strings.Contains(response.Header().Get("Allow"), item.allow) {
			t.Fatalf("wrong Allow header: %s", response.Header().Get("Allow"))
		}
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskCollection("00000000-0000-4000-8000-000000000099")+"/"+task.ID+"/properties", ""), http.StatusNotFound, "not_found")
}

func TestTaskPropertyResourceRejectsInvalidInputsWithoutMutation(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Validate input")
	path := taskPath(task) + "/properties"
	for _, value := range []string{"", `null`, `{}`, `1`, `true`, `"text"`, `[] []`, `[{"url":"private-value-secret","url":"duplicate","title":"x"}]`, `[{"url":"x"}]`} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/pullRequests", jsonBody(t, map[string]any{"version": task.Version, "valueText": value})), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{}`, `{"version":1}`, `{"version":1,"valueText":null}`, `{"version":1,"valueText":[]}`, `{"version":1,"valueText":"[]","unknown":1}`, `{"version":1,"version":1,"valueText":"[]"}`, `{"version":0,"valueText":"[]"}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/pullRequests", body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{}`, `{"version":null}`, `{"version":0}`, `{"version":1,"valueText":"[]"}`} {
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path+"/pullRequests", body), http.StatusBadRequest, "invalid_input")
	}
	for _, name := range []string{"worker", "unknown-property-private-name-secret"} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/"+name, `{"version":1,"valueText":"null"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path+"/"+name, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("refused property operation changed task")
	}
	if strings.Contains(logs.String(), "private-value-secret") || strings.Contains(logs.String(), "private-name-secret") {
		t.Fatalf("refused property contents leaked: %s", &logs)
	}
}

func TestTaskPropertyResourceWireLimitAndDatabaseFailure(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Wire limit")
	path := taskPath(task) + "/properties"
	initial := propertyResource(t, handler, http.MethodPut, path+"/pullRequests", map[string]any{"version": task.Version, "valueText": "[]"})
	body := jsonBody(t, map[string]any{"version": initial.Version, "valueText": "[]"})
	body += strings.Repeat(" ", maxJSONBody-len(body))
	atLimit := decodeResponse[api.PropertyResource](t, projectRequest(handler, http.MethodPut, path+"/pullRequests", body), http.StatusOK)
	if !reflect.DeepEqual(atLimit, initial) {
		t.Fatal("exact-limit no-op changed values")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/pullRequests", body+" "), http.StatusBadRequest, "invalid_input")
	if _, err := database.Pool.Exec(context.Background(), "ALTER TABLE task_properties RENAME TO private_property_table_secret"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ method, suffix, body string }{{"GET", "", ""}, {"PUT", "/pullRequests", jsonBody(t, map[string]any{"version": initial.Version, "valueText": "[]"})}, {"DELETE", "/pullRequests", jsonBody(t, map[string]any{"version": initial.Version})}} {
		response := projectRequest(handler, item.method, path+item.suffix, item.body)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("database failure leaked: %s", response.Body)
		}
	}
	if strings.Contains(logs.String(), "private_property_table_secret") {
		t.Fatalf("database detail leaked: %s", &logs)
	}
}

func TestTaskPropertyResourcePreservesProtectedWorker(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	extendedWorkerTestHandler(handler)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Claim preservation"), map[string]any{"allowAgents": true})
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	worker := apiWorker(t, task.Properties)
	path := taskPath(task) + "/properties"
	set := propertyResource(t, handler, http.MethodPut, path+"/pullRequests", map[string]any{"version": task.Version, "valueText": "[]"})
	if !reflect.DeepEqual(apiWorker(t, set.Properties), worker) {
		t.Fatal("setting writable property changed protected worker")
	}
	removed := propertyResource(t, handler, http.MethodDelete, path+"/pullRequests", map[string]any{"version": set.Version})
	if !reflect.DeepEqual(apiWorker(t, removed.Properties), worker) || len(removed.Properties) != 1 {
		t.Fatal("removing writable property changed protected worker")
	}
	read := readHTTPTask(t, handler, task)
	if read.Status != task.Status || read.AllowAgents != task.AllowAgents || !reflect.DeepEqual(read.StartedAt, task.StartedAt) || !reflect.DeepEqual(apiWorker(t, read.Properties), worker) {
		t.Fatal("property mutation changed unrelated task or claim data")
	}
}
