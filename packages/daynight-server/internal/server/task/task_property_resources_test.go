package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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
	task := testTask("Task description stays outside property response")
	input := `[{"url":" opaque-property-private-secret\u0000 ","title":"value"},{"url":"same","title":"second"}]`
	for _, tc := range []struct {
		name, method, value string
		properties          model.TaskProperties
		version             int64
	}{
		{"read", http.MethodGet, "", model.TaskProperties{}, 1},
		{"set", http.MethodPut, input, model.TaskProperties{"pullRequests": json.RawMessage(input)}, 2},
		{"equivalent set", http.MethodPut, ` [ { "title":"value", "url":" opaque-property-private-secret\u0000 " }, {"title":"second","url":"same"} ] `, model.TaskProperties{"pullRequests": json.RawMessage(input)}, 1},
		{"empty value", http.MethodPut, "[]", model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}, 2},
		{"remove", http.MethodDelete, "", model.TaskProperties{}, 2},
		{"absent remove", http.MethodDelete, "", model.TaskProperties{}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			result := propertyResult(task, tc.properties)
			result.Version = tc.version
			path := propertyTaskPath(task) + "/properties"
			var body any
			switch tc.method {
			case http.MethodGet:
				h.Tasks.GetFunc = func(ctx context.Context, p model.Principal, projectID, id string) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					return result, nil
				}
			case http.MethodPut:
				path += "/pullRequests"
				body = map[string]any{"version": task.Version, "valueText": tc.value}
				h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					if name != "pullRequests" || value != tc.value || version != task.Version {
						t.Fatalf("set property parameters changed: name=%s version=%d value=%q", name, version, value)
					}
					return result, nil
				}
			case http.MethodDelete:
				path += "/pullRequests"
				body = map[string]any{"version": task.Version}
				h.Tasks.RemovePropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name string, version int64) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					if name != "pullRequests" || version != task.Version {
						t.Fatal("remove property parameters changed")
					}
					return result, nil
				}
			}
			actual := propertyResource(t, h, tc.method, path, body)
			if actual.ProjectID != task.ProjectID || actual.TaskID != task.ID || actual.Version != result.Version || actual.Properties == nil || !reflect.DeepEqual(model.TaskProperties(actual.Properties), tc.properties) {
				t.Fatalf("property response changed service result: %#v", actual)
			}
			if strings.Contains(logs.String(), "property-private-secret") || strings.Contains(logs.String(), "Task description stays") {
				t.Fatalf("property contents leaked: %s", &logs)
			}
			if tc.method != http.MethodGet {
				outcome := "changed"
				if tc.version == task.Version {
					outcome = "unchanged"
				}
				if !strings.Contains(logs.String(), `"outcome":"`+outcome+`"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) {
					t.Fatalf("property operation outcome changed: %s", &logs)
				}
			}
		})
	}
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		t.Run("stale "+method, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			fault := &model.Fault{Code: "version_conflict", Message: "Task changed."}
			h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if version != task.Version {
					t.Fatal("stale version altered")
				}
				return model.Task{}, fault
			}
			h.Tasks.RemovePropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if version != task.Version {
					t.Fatal("stale version altered")
				}
				return model.Task{}, fault
			}
			if method == http.MethodPut {
				h.Tasks.ExpectCalls("RemoveProperty", 0)
			} else {
				h.Tasks.ExpectCalls("SetProperty", 0)
			}
			body := map[string]any{"version": task.Version}
			if method == http.MethodPut {
				body["valueText"] = input
			}
			assertProjectError(t, projectRequest(h, method, propertyTaskPath(task)+"/properties/pullRequests", jsonBody(t, body)), http.StatusConflict, "version_conflict")
		})
	}
}

func TestTaskPropertyResourceSchemaAuthenticationAndMethods(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	schemaPath := "/api/v1/task-properties/schema"
	schema := decodeResponse[api.TaskPropertySchema](t, projectRequest(h, http.MethodGet, schemaPath, ""), http.StatusOK)
	prs, hasPR := schema.Properties["pullRequests"]
	paused, hasPaused := schema.Properties["paused"]
	worker, hasWorker := schema.Properties["worker"]
	if !hasPR || !hasPaused || !hasWorker || prs.ReadOnly || paused.ReadOnly || !worker.ReadOnly || string(paused.Schema) != `{"type":"boolean"}` || len(prs.Schema) == 0 || len(worker.Schema) == 0 {
		t.Fatalf("invalid property catalogue: %#v", schema)
	}
	var workerSchema map[string]any
	if err := json.Unmarshal(worker.Schema, &workerSchema); err != nil {
		t.Fatal(err)
	}
	fields, ok := workerSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("worker schema omits fields: %s", worker.Schema)
	}
	for _, name := range []string{"claimId", "agentControlMode", "phase", "nativeSessionId", "claimedAt"} {
		if _, exists := fields[name]; !exists {
			t.Fatalf("worker schema omits %s", name)
		}
	}
	task := testTask("Read values")
	path := propertyTaskPath(task) + "/properties"
	h.Tasks.GetFunc = func(ctx context.Context, p model.Principal, projectID, id string) (model.Task, error) {
		requirePropertyCall(t, ctx, p, projectID, id)
		return task, nil
	}
	for _, target := range []string{schemaPath, path} {
		response := projectRequest(h, http.MethodHead, target, "")
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("HEAD property resource: %d %s", response.Code, response.Body)
		}
	}
	for _, item := range []struct{ method, path, body string }{{"GET", schemaPath, ""}, {"GET", path, ""}, {"PUT", path + "/pullRequests", `{"version":1,"valueText":"[]"}`}, {"DELETE", path + "/pullRequests", `{"version":1}`}} {
		request := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	}
	for _, item := range []struct{ method, path, allow string }{{"POST", schemaPath, "GET"}, {"POST", path, "GET"}, {"POST", path + "/pullRequests", "PUT"}} {
		response := projectRequest(h, item.method, item.path, `{}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if !strings.Contains(response.Header().Get("Allow"), item.allow) {
			t.Fatalf("wrong Allow header: %s", response.Header().Get("Allow"))
		}
	}
	refused := newHTTPFixture(t, io.Discard)
	refused.Tasks.GetFunc = func(context.Context, model.Principal, string, string) (model.Task, error) {
		return model.Task{}, &model.Fault{Code: "not_found", Message: "Task not found."}
	}
	assertProjectError(t, projectRequest(refused, http.MethodGet, taskCollection("00000000-0000-4000-8000-000000000099")+"/"+task.ID+"/properties", ""), http.StatusNotFound, "not_found")
}

func TestTaskPropertyResourceRejectsInvalidInputsWithoutMutation(t *testing.T) {
	path := propertyTaskPath(testTask("Validate input")) + "/properties"
	for _, value := range []string{"", `null`, `{}`, `1`, `true`, `"text"`, `[] []`, `[{"url":"private-value-secret","url":"duplicate","title":"x"}]`, `[{"url":"x"}]`} {
		t.Run("value "+value, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, got string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if got != value || name != "pullRequests" || version != 1 {
					t.Fatal("property valueText changed before service")
				}
				return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid property."}
			}
			assertProjectError(t, projectRequest(h, http.MethodPut, path+"/pullRequests", jsonBody(t, map[string]any{"version": 1, "valueText": value})), http.StatusBadRequest, "invalid_input")
			if strings.Contains(logs.String(), "private-value-secret") {
				t.Fatalf("property value leaked: %s", &logs)
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	for _, body := range []string{`{}`, `{"version":1}`, `{"version":1,"valueText":null}`, `{"version":1,"valueText":[]}`, `{"version":1,"valueText":"[]","unknown":1}`, `{"version":1,"version":1,"valueText":"[]"}`, `{"version":0,"valueText":"[]"}`} {
		assertProjectError(t, projectRequest(h, http.MethodPut, path+"/pullRequests", body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{}`, `{"version":null}`, `{"version":0}`, `{"version":1,"valueText":"[]"}`} {
		assertProjectError(t, projectRequest(h, http.MethodDelete, path+"/pullRequests", body), http.StatusBadRequest, "invalid_input")
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatal("invalid property body called service")
	}
	for _, name := range []string{"worker", "unknown-property-private-name-secret"} {
		t.Run("name "+name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			fault := &model.Fault{Code: "invalid_input", Message: "Property cannot be written."}
			h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, got, value string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if got != name || value != "null" || version != 1 {
					t.Fatal("property name/value changed")
				}
				return model.Task{}, fault
			}
			h.Tasks.RemovePropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, got string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if got != name || version != 1 {
					t.Fatal("property name changed")
				}
				return model.Task{}, fault
			}
			assertProjectError(t, projectRequest(h, http.MethodPut, path+"/"+name, `{"version":1,"valueText":"null"}`), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(h, http.MethodDelete, path+"/"+name, `{"version":1}`), http.StatusBadRequest, "invalid_input")
			if strings.Contains(logs.String(), "private-name-secret") {
				t.Fatalf("unknown property name leaked: %s", &logs)
			}
		})
	}
}

func TestTaskPropertyResourceWireLimitAndDatabaseFailure(t *testing.T) {
	task := testTask("Wire limit")
	path := propertyTaskPath(task) + "/properties"
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
		requirePropertyCall(t, ctx, p, projectID, id)
		if name != "pullRequests" || value != "[]" || version != task.Version {
			t.Fatal("exact body boundary changed property input")
		}
		return propertyResult(task, model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}), nil
	}
	body := jsonBody(t, map[string]any{"version": task.Version, "valueText": "[]"})
	body += strings.Repeat(" ", httpx.MaxJSONBody-len(body))
	result := decodeResponse[api.PropertyResource](t, projectRequest(h, http.MethodPut, path+"/pullRequests", body), http.StatusOK)
	if result.Version != task.Version || string(result.Properties["pullRequests"]) != "[]" {
		t.Fatal("exact-limit property response changed")
	}
	assertProjectError(t, projectRequest(h, http.MethodPut, path+"/pullRequests", body+" "), http.StatusRequestEntityTooLarge, "payload_too_large")
	if h.Tasks.Calls("SetProperty") != 1 {
		t.Fatal("oversized body reached service")
	}
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			cause := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_property_table_secret")}
			switch method {
			case http.MethodGet:
				h.Tasks.GetFunc = func(context.Context, model.Principal, string, string) (model.Task, error) { return model.Task{}, cause }
			case http.MethodPut:
				h.Tasks.SetPropertyFunc = func(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error) {
					return model.Task{}, cause
				}
			case http.MethodDelete:
				h.Tasks.RemovePropertyFunc = func(context.Context, model.Principal, string, string, string, int64) (model.Task, error) {
					return model.Task{}, cause
				}
			}
			suffix, input := "", ""
			if method != http.MethodGet {
				suffix = "/pullRequests"
				input = `{"version":1}`
				if method == http.MethodPut {
					input = `{"version":1,"valueText":"[]"}`
				}
			}
			response := projectRequest(h, method, path+suffix, input)
			assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
			if strings.Contains(response.Body.String(), "secret") || strings.Contains(logs.String(), "private_property_table_secret") {
				t.Fatalf("storage error disclosed cause: %s %s", response.Body, &logs)
			}
		})
	}
}

func TestTaskPausedPropertyResourcePreservesActiveWorkerAndPresence(t *testing.T) {
	task := propertyHTTPActiveTask(t)
	for _, tc := range []struct {
		name, method, value string
		present             bool
		version             int64
	}{
		{"set true", http.MethodPut, "true", true, 2}, {"set false", http.MethodPut, "false", true, 2}, {"equivalent true", http.MethodPut, " \ntrue ", true, 1}, {"equivalent false", http.MethodPut, " \nfalse ", true, 1}, {"remove", http.MethodDelete, "", false, 2}, {"absent remove", http.MethodDelete, "", false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			properties := maps.Clone(task.Properties)
			if tc.present {
				properties["paused"] = json.RawMessage(strings.TrimSpace(tc.value))
			}
			result := propertyResult(task, properties)
			result.Version = tc.version
			body := map[string]any{"version": task.Version}
			if tc.method == http.MethodPut {
				body["valueText"] = tc.value
				h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					if name != "paused" || value != tc.value || version != task.Version {
						t.Fatal("pause value or version changed")
					}
					return result, nil
				}
			} else {
				h.Tasks.RemovePropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name string, version int64) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					if name != "paused" || version != task.Version {
						t.Fatal("pause removal changed")
					}
					return result, nil
				}
			}
			actual := propertyResource(t, h, tc.method, propertyTaskPath(task)+"/properties/paused", body)
			raw, present := actual.Properties["paused"]
			if present != tc.present || tc.present && string(raw) != strings.TrimSpace(tc.value) || !bytes.Equal(actual.Properties["worker"], task.Properties["worker"]) {
				t.Fatalf("pause response lost presence or execution: %#v", actual)
			}
		})
	}
	for _, value := range []string{"", "null", `"true"`, `"false"`, "0", "1", "[]", "{}", "[true]", "true false"} {
		t.Run("invalid "+value, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, got string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if got != value || name != "paused" {
					t.Fatal("invalid pause input changed")
				}
				return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid pause."}
			}
			assertProjectError(t, projectRequest(h, http.MethodPut, propertyTaskPath(task)+"/properties/paused", jsonBody(t, map[string]any{"version": task.Version, "valueText": value})), http.StatusBadRequest, "invalid_input")
		})
	}
}

func TestTaskPropertyResourceRejectsQueriesAndMalformedIDs(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	path := propertyTaskPath(testTask("Resource validation")) + "/properties"
	for _, query := range []string{"?unknown=1", "?"} {
		for _, request := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/v1/task-properties/schema" + query, ""}, {http.MethodGet, path + query, ""}, {http.MethodPut, path + "/pullRequests" + query, `{"version":1,"valueText":"[]"}`}, {http.MethodDelete, path + "/pullRequests" + query, `{"version":1}`},
		} {
			assertProjectError(t, projectRequest(h, request.method, request.path, request.body), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, path := range []string{taskCollection("not-a-project-id") + "/" + testTaskID + "/properties", taskCollection(testProjectID) + "/not-a-task-id/properties"} {
		assertProjectError(t, projectRequest(h, http.MethodGet, path, ""), http.StatusBadRequest, "invalid_input")
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatal("refused property resource called service")
	}
}

func TestWorkerClaimRejectsMalformedResourceIDs(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	for _, path := range []string{taskCollection("not-a-project-id") + "/" + testTaskID + "/worker-claim", taskCollection(testProjectID) + "/not-a-task-id/worker-claim"} {
		assertProjectError(t, projectRequest(h, http.MethodPost, path, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatal("malformed claim resource reached service")
	}
}

func TestPausedBlockedTaskRetainsDependencyAndInventory(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	task := testTask("Dependent")
	task.DependsOn = []string{testEpoch}
	task.BlockedBy = []string{testEpoch}
	task.Ready = false
	result := propertyResult(task, model.TaskProperties{"paused": json.RawMessage("true")})
	h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
		requirePropertyCall(t, ctx, p, projectID, id)
		if name != "paused" || value != "true" || version != task.Version {
			t.Fatal("blocked pause call changed")
		}
		return result, nil
	}
	actual := propertyResource(t, h, http.MethodPut, propertyTaskPath(task)+"/properties/paused", map[string]any{"version": task.Version, "valueText": "true"})
	if actual.ProjectID != task.ProjectID || actual.TaskID != task.ID || string(actual.Properties["paused"]) != "true" {
		t.Fatal("blocked task property response changed")
	}
	h.Tasks.ObserveRESTFunc = func(ctx context.Context, p model.Principal, projectID, id string, extended bool) (taskservice.TaskObservation, error) {
		requirePropertyCall(t, ctx, p, projectID, id)
		return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
	}
	read := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, propertyTaskPath(task), ""), http.StatusOK)
	if read.Status != "todo" || read.Ready || !reflect.DeepEqual(read.DependsOn, task.DependsOn) || !reflect.DeepEqual(read.BlockedBy, task.BlockedBy) || string(read.Properties["paused"]) != "true" {
		t.Fatalf("paused task read lost derived fields: %#v", read)
	}
	prerequisite := testTask("Prerequisite")
	prerequisite.ID = testEpoch
	h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		requirePropertyCall(t, ctx, p, projectID, testTaskID)
		return taskservice.TaskPage{Items: []model.Task{prerequisite, result}}, nil
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, taskCollection(testProjectID), ""), http.StatusOK)
	if len(page.Items) != 2 || page.NextCursor != nil || page.Items[0].ID != testEpoch || !reflect.DeepEqual(page.Items[1], read) {
		t.Fatalf("paused task list changed service inventory: %#v", page)
	}
}

func TestTaskWriteAdmissionHTTP(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input map[string]any
		fault string
	}{
		{"exact title and description", map[string]any{"title": strings.Repeat("界", 341) + "x", "description": strings.Repeat("d", 65536)}, ""},
		{"title over limit", map[string]any{"title": strings.Repeat("界", 341) + "xx"}, "invalid_input"},
		{"description over limit", map[string]any{"title": "x", "description": strings.Repeat("d", 65537)}, "invalid_input"},
		{"blank title", map[string]any{"title": " ", "description": "valid"}, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.CreateFunc = func(ctx context.Context, p model.Principal, projectID string, actual taskcore.CreateTask) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, testTaskID)
				if actual.Title != tc.input["title"] {
					t.Fatal("title bytes changed")
				}
				if description, ok := tc.input["description"]; ok && actual.Description != description {
					t.Fatal("description bytes changed")
				}
				if tc.fault != "" {
					return model.Task{}, &model.Fault{Code: tc.fault, Message: "Task input refused."}
				}
				result := testTask(actual.Title)
				result.Description = actual.Description
				return result, nil
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID), jsonBody(t, tc.input))
			if tc.fault == "" {
				decodeResponse[api.Task](t, response, http.StatusCreated)
			} else {
				assertProjectError(t, response, http.StatusBadRequest, tc.fault)
			}
		})
	}
	prs := []map[string]string{{"url": strings.Repeat("x", 2000), "title": ""}, {"url": strings.Repeat("x", 2000), "title": ""}, {"url": strings.Repeat("x", 2000), "title": ""}, {"url": strings.Repeat("x", 2000), "title": ""}}
	raw, err := json.Marshal(prs)
	if err != nil {
		t.Fatal(err)
	}
	prs[0]["title"] = strings.Repeat("q", 8192-len(raw))
	raw, err = json.Marshal(prs)
	if err != nil || len(raw) != 8192 {
		t.Fatalf("boundary fixture: %d %v", len(raw), err)
	}
	for _, n := range []int{8192, 8193} {
		t.Run("property "+strconv.Itoa(n), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			value := string(raw)
			if n == 8193 {
				values := append([]map[string]string{}, prs...)
				values[0] = maps.Clone(values[0])
				values[0]["title"] += "q"
				encoded, err := json.Marshal(values)
				if err != nil {
					t.Fatal(err)
				}
				value = string(encoded)
			}
			h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, actual string, version int64) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if name != "pullRequests" || actual != value || len(actual) != n || version != 1 {
					t.Fatal("property byte-boundary input changed")
				}
				if n == 8193 {
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Property too large."}
				}
				return propertyResult(testTask("Boundary"), model.TaskProperties{"pullRequests": json.RawMessage(value)}), nil
			}
			response := projectRequest(h, http.MethodPut, propertyTaskPath(testTask("Boundary"))+"/properties/pullRequests", jsonBody(t, map[string]any{"version": 1, "valueText": value}))
			if n == 8192 {
				decodeResponse[api.PropertyResource](t, response, http.StatusOK)
			} else {
				assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			}
		})
	}
	large := append([]map[string]string{}, prs...)
	large[0] = maps.Clone(large[0])
	large[0]["title"] += "q"
	encoded, err := json.Marshal(large)
	if err != nil || len(encoded) != 8193 {
		t.Fatalf("over-limit fixture: %d %v", len(encoded), err)
	}
	for _, tc := range []struct {
		name, method, fault string
		version             int64
	}{
		{"stale property", http.MethodPut, "version_conflict", 1},
		{"current patch", http.MethodPatch, "invalid_input", 2},
		{"stale patch", http.MethodPatch, "version_conflict", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			fault := &model.Fault{Code: tc.fault, Message: "Property write refused."}
			path := propertyTaskPath(testTask("Boundary"))
			var body any
			if tc.method == http.MethodPut {
				path += "/properties/pullRequests"
				body = map[string]any{"version": tc.version, "valueText": string(encoded)}
				h.Tasks.SetPropertyFunc = func(ctx context.Context, p model.Principal, projectID, id, name, value string, version int64) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					if name != "pullRequests" || value != string(encoded) || version != tc.version {
						t.Fatal("stale property parameters changed")
					}
					return model.Task{}, fault
				}
			} else {
				body = map[string]any{"version": tc.version, "title": "Must roll back", "properties": map[string]any{"pullRequests": large, "paused": true}}
				var expected []api.PullRequestProperty
				if err := json.Unmarshal(encoded, &expected); err != nil {
					t.Fatal(err)
				}
				h.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
					requirePropertyCall(t, ctx, p, projectID, id)
					raw := input.Properties["pullRequests"]
					var actual []api.PullRequestProperty
					decodeErr := json.Unmarshal(raw, &actual)
					if input.Version != tc.version || input.Title == nil || *input.Title != "Must roll back" || input.Properties == nil || len(raw) != 8193 || decodeErr != nil || !slices.Equal(actual, expected) || string(input.Properties["paused"]) != "true" {
						t.Fatalf("property patch changed: version=%d property_bytes=%d items=%d paused=%s decode=%v", input.Version, len(raw), len(actual), input.Properties["paused"], decodeErr)
					}
					return model.Task{}, fault
				}
			}
			status := http.StatusBadRequest
			if tc.fault == "version_conflict" {
				status = http.StatusConflict
			}
			assertProjectError(t, projectRequest(h, tc.method, path, jsonBody(t, body)), status, tc.fault)
		})
	}
}
