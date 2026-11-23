package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPCreateUpdateReadAndListProjection(t *testing.T) {
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	created := testTask("Default values")
	changed := created
	changed.Title, changed.Description, changed.Version = "Renamed", "Filled", 4
	h.Tasks.CreateFunc = func(ctx context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || input.Title != "Default values" || input.Description != "" || len(input.DependsOn) != 0 || input.DependsOn == nil || input.Properties == nil || len(input.Properties) != 0 || input.AssignedTo != nil || input.RequiredPlatform != nil || input.Status != nil {
			t.Fatalf("create input: %+v principal=%+v project=%s", input, principal, projectID)
		}
		return created, nil
	}
	h.Tasks.UpdateFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 3 || input.Title == nil || *input.Title != "Renamed" || input.Description == nil || *input.Description != "Filled" || input.DependsOn == nil || len(*input.DependsOn) != 0 || input.ExternalDependsOn != nil || input.Properties != nil || input.AllowAgents != nil || input.AssignedTo != nil || input.RequiredPlatform != nil {
			t.Fatalf("update input: %+v", input)
		}
		return changed, nil
	}
	h.Tasks.ObserveFunc = func(ctx context.Context, principal model.Principal, projectID, id string) (taskservice.TaskObservation, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID {
			t.Fatalf("read scope: %+v %s %s", principal, projectID, id)
		}
		return taskservice.TaskObservation{Task: changed, Epoch: testEpoch}, nil
	}
	h.Tasks.ListFunc = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || !reflect.DeepEqual(input, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}, TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}}) {
			t.Fatalf("list input: %+v", input)
		}
		return taskservice.TaskPage{Items: []model.Task{changed}}, nil
	}
	collection := taskCollection(testProjectID)
	response := projectRequest(h, http.MethodPost, collection, `{"title":"Default values"}`)
	actual := decodeResponse[api.Task](t, response, http.StatusCreated)
	if actual.ID != created.ID || actual.Type != model.TaskTypeTask || actual.ParentID != nil || actual.ProjectID != created.ProjectID || actual.Title != created.Title || actual.Description != created.Description || actual.Status != string(created.Status) || actual.Version != created.Version || actual.Ready != created.Ready || !reflect.DeepEqual(actual.DependsOn, created.DependsOn) || !reflect.DeepEqual(actual.BlockedBy, created.BlockedBy) || actual.CreatedAt != created.CreatedAt || actual.UpdatedAt != created.UpdatedAt || response.Header().Get("Location") != collection+"/"+testTaskID {
		t.Fatalf("created DTO: %+v headers=%v", actual, response.Header())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 22 {
		t.Fatalf("task DTO fields: %s %v", response.Body, err)
	}
	for _, key := range []string{"id", "type", "parentId", "projectId", "title", "description", "status", "version", "createdAt", "updatedAt", "dependsOn", "externalDependsOn", "blockedBy", "ready", "properties", "tags", "allowAgents", "requiredPlatform", "assignedTo", "cancelledAt", "startedAt", "completedAt"} {
		if _, exists := fields[key]; !exists {
			t.Fatalf("missing task DTO field %s", key)
		}
	}
	updated := decodeResponse[api.Task](t, projectRequest(h, http.MethodPatch, collection+"/"+testTaskID, `{"version":3,"title":"Renamed","description":"Filled","dependsOn":[]}`), http.StatusOK)
	if updated.Title != changed.Title || updated.Description != changed.Description || updated.Version != changed.Version {
		t.Fatalf("updated DTO: %+v", updated)
	}
	readResponse := projectRequest(h, http.MethodGet, taskCollection(strings.ToUpper(testProjectID))+"/"+strings.ToUpper(testTaskID), "")
	read := decodeResponse[api.Task](t, readResponse, http.StatusOK)
	if !reflect.DeepEqual(read, updated) || readResponse.Header().Get("Daynight-Task-Epoch") != testEpoch {
		t.Fatalf("observed DTO: %+v headers=%v", read, readResponse.Header())
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, collection, ""), http.StatusOK)
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], updated) || page.NextCursor != nil {
		t.Fatalf("task list DTO: %+v", page)
	}
	for _, fragment := range []string{`"project_id":"` + testProjectID + `"`, `"task_id":"` + testTaskID + `"`, `"route":"PATCH /api/v1/projects/{projectId}/tasks/{taskId}"`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("missing diagnostics %s: %s", fragment, &logs)
		}
	}
	if strings.Contains(logs.String(), "Filled") || strings.Contains(logs.String(), "Default values") {
		t.Fatalf("task data leaked in diagnostics: %s", &logs)
	}
}

func taskHTTPStatus(value model.TaskStatus) *model.TaskStatus { return &value }

func TestTaskHTTPCreateStatusForwarding(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status *model.TaskStatus
	}{
		{name: "omitted"},
		{name: "proposed", status: taskHTTPStatus(model.TaskProposed)},
		{name: "todo", status: taskHTTPStatus(model.TaskTodo)},
		{name: "invalid", status: taskHTTPStatus("unknown")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Creation status")
			result.Status, result.Ready = model.TaskProposed, false
			if tc.status != nil {
				result.Status = *tc.status
				result.Ready = *tc.status == model.TaskTodo
			}
			h.Tasks.CreateFunc = func(_ context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
				if principal != h.principal || projectID != testProjectID || !reflect.DeepEqual(input.Status, tc.status) {
					t.Fatalf("creation status was changed: %+v", input)
				}
				if tc.name == "invalid" {
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid creation status."}
				}
				return result, nil
			}
			body := map[string]any{"title": result.Title}
			if tc.status != nil {
				body["status"] = *tc.status
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID), jsonBody(t, body))
			if tc.name == "invalid" {
				assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
				return
			}
			actual := decodeResponse[api.Task](t, response, http.StatusCreated)
			if actual.Status != string(result.Status) || actual.Ready != result.Ready {
				t.Fatalf("creation status projection: %+v", actual)
			}
		})
	}
}

func TestTaskHTTPStrictInputsDoNotCallService(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	collection := taskCollection(testProjectID)
	path := collection + "/" + testTaskID
	for _, body := range []string{
		"", "null", "[]", `{`, `{"title":"x"]`, `{"title":"x"} {}`,
		`{"Title":"x"}`, `{"title":"x","title":"y"}`, `{"title":"x","ti\u0074le":"y"}`,
		`{}`, `{"title":null}`, `{"title":true}`, `{"title":[]}`,
		`{"title":"x","description":null}`, `{"title":"x","description":1}`,
		`{"title":"x","dependsOn":null}`, `{"title":"x","dependsOn":{}}`, `{"title":"x","dependsOn":"id"}`,
		`{"title":"x","dependsOn":[null]}`, `{"title":"x","dependsOn":[1]}`, `{"title":"x","dependsOn":[{}]}`,
		`{"title":"x","tagIds":null}`, `{"title":"x","tagIds":"name"}`, `{"title":"x","tagIds":[null]}`, `{"title":"x","tagIds":[1]}`, `{"title":"x","tagIds":[],"tagIds":[]}`,
		`{"title":"x","status":null}`, `{"title":"x","status":1}`, `{"title":"x","status":[]}`, `{"title":"x","status":{}}`, `{"title":"x","version":1}`, `{"title":"x","projectId":"readonly"}`, `{"title":"x","unknown":"secret-body"}`,
		`{"title":"x","type":null}`, `{"title":"x","type":""}`, `{"title":"x","type":true}`, `{"title":"x","parentId":true}`, `{"title":"x","parentId":[]}`,
		"{\"title\":\"" + string([]byte{0xff}) + "\"}",
	} {
		t.Run("create_"+body[:min(len(body), 70)], func(t *testing.T) {
			assertProjectError(t, projectRequest(h, http.MethodPost, collection, body), http.StatusBadRequest, "invalid_input")
		})
	}
	assertProjectError(t, projectRequest(h, http.MethodPost, collection, `{"title":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"}`), http.StatusRequestEntityTooLarge, "payload_too_large")
	for _, body := range []string{
		"", "null", `[]`, `{"version":1,}`, `{"version":1,"title":"x"} false`,
		`{}`, `{"title":"x"}`, `{"version":1}`, `{"version":null,"title":"x"}`, `{"version":0,"title":"x"}`, `{"version":-1,"title":"x"}`, `{"version":"1","title":"x"}`, `{"version":true,"title":"x"}`,
		`{"version":1.0,"title":"x"}`, `{"version":1e0,"title":"x"}`, `{"version":9223372036854775808,"title":"x"}`,
		`{"version":1,"Title":"x"}`, `{"version":1,"version":1,"title":"x"}`, `{"version":1,"id":"readonly"}`, `{"version":1,"title":null}`, `{"version":1,"title":1}`,
		`{"version":1,"description":null}`, `{"version":1,"description":false}`, `{"version":1,"status":null}`, `{"version":1,"status":[]}`, `{"version":1,"status":"blocked"}`, `{"version":1,"status":"todo"}`, `{"version":1,"status":"done","title":"Changed"}`,
		`{"version":1,"dependsOn":null}`, `{"version":1,"dependsOn":true}`, `{"version":1,"dependsOn":[null]}`, `{"version":1,"unknown":"private-body-secret"}`,
		`{"version":1,"tagIds":null}`, `{"version":1,"tagIds":"name"}`, `{"version":1,"tagIds":[null]}`, `{"version":1,"tagIds":[1]}`, `{"version":1,"tagIds":[],"tagIds":[]}`,
		`{"version":1,"type":"goal"}`, `{"version":1,"title":"x","type":"task"}`, `{"version":1,"parentId":true}`, `{"version":1,"parentId":[]}`,
	} {
		t.Run("patch_"+body[:min(len(body), 70)], func(t *testing.T) {
			assertProjectError(t, projectRequest(h, http.MethodPatch, path, body), http.StatusBadRequest, "invalid_input")
		})
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatalf("protocol refusal called service %d times", h.Tasks.TotalCalls())
	}
	for _, tc := range []struct{ method, body string }{
		{http.MethodPost, `{"title":" "}`}, {http.MethodPost, `{"title":"\u0000"}`}, {http.MethodPost, `{"title":"x","description":"\u0000"}`}, {http.MethodPost, `{"title":"x","dependsOn":["invalid"]}`},
		{http.MethodPatch, `{"version":1,"title":" "}`}, {http.MethodPatch, `{"version":1,"description":"\u0000"}`}, {http.MethodPatch, `{"version":1,"dependsOn":["invalid"]}`},
	} {
		t.Run("domain_"+tc.method+tc.body, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.body), &fields); err != nil {
				t.Fatal(err)
			}
			target := collection
			if tc.method == http.MethodPost {
				f.Tasks.CreateFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
					var title string
					if err := json.Unmarshal(fields["title"], &title); err != nil {
						t.Fatal(err)
					}
					if input.Title != title {
						t.Fatalf("domain title changed: %q", input.Title)
					}
					if raw, exists := fields["description"]; exists {
						var description string
						if err := json.Unmarshal(raw, &description); err != nil {
							t.Fatal(err)
						}
						if input.Description != description {
							t.Fatalf("domain description changed: %q", input.Description)
						}
					}
					if raw, exists := fields["dependsOn"]; exists {
						var dependencies []string
						if err := json.Unmarshal(raw, &dependencies); err != nil {
							t.Fatal(err)
						}
						if !slices.Equal(input.DependsOn, dependencies) {
							t.Fatalf("domain dependencies changed: %v", input.DependsOn)
						}
					}
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Task input is invalid."}
				}
			} else {
				target = path
				f.Tasks.UpdateFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.UpdateTask) (model.Task, error) {
					if input.Version != 1 {
						t.Fatalf("domain version changed: %+v", input)
					}
					if raw, exists := fields["title"]; exists {
						var title string
						if err := json.Unmarshal(raw, &title); err != nil {
							t.Fatal(err)
						}
						if input.Title == nil || *input.Title != title {
							t.Fatalf("domain title changed: %+v", input)
						}
					}
					if raw, exists := fields["description"]; exists {
						var description string
						if err := json.Unmarshal(raw, &description); err != nil {
							t.Fatal(err)
						}
						if input.Description == nil || *input.Description != description {
							t.Fatalf("domain description changed: %+v", input)
						}
					}
					if raw, exists := fields["dependsOn"]; exists {
						var dependencies []string
						if err := json.Unmarshal(raw, &dependencies); err != nil {
							t.Fatal(err)
						}
						if input.DependsOn == nil || !slices.Equal(*input.DependsOn, dependencies) {
							t.Fatalf("domain dependencies changed: %+v", input)
						}
					}
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Task input is invalid."}
				}
			}
			assertProjectError(t, projectRequest(f, tc.method, target, tc.body), http.StatusBadRequest, "invalid_input")
		})
	}
}

func TestTaskHTTPDependencyErrorsAndDerivedFields(t *testing.T) {
	dependencies := []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
	for _, code := range []string{"dependency_unsatisfied", "dependency_cycle", "version_conflict"} {
		t.Run(code, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			h.Tasks.UpdateFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
				if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 7 || input.DependsOn == nil || !slices.Equal(*input.DependsOn, dependencies) {
					t.Fatalf("dependency update: %+v", input)
				}
				return model.Task{}, &model.Fault{Code: code, Message: "Task dependency operation refused.", TaskIDs: dependencies}
			}
			response := projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, jsonBody(t, map[string]any{"version": 7, "dependsOn": dependencies}))
			fault := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
			if fault.Error.Code != code || fault.Error.Details == nil || !slices.Equal(fault.Error.Details.TaskIDs, dependencies) {
				t.Fatalf("dependency error details: %+v", fault)
			}
			if !strings.Contains(logs.String(), `"cause":"`+code+`"`) || !strings.Contains(logs.String(), `"error_code":"`+code+`"`) {
				t.Fatalf("dependency error classification: %s", &logs)
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	result := testTask("Blocked target")
	result.DependsOn, result.BlockedBy, result.Ready = dependencies, slices.Clone(dependencies), false
	h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
	}
	actual := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, ""), http.StatusOK)
	if actual.Ready || !slices.Equal(actual.DependsOn, dependencies) || !slices.Equal(actual.BlockedBy, dependencies) {
		t.Fatalf("derived DTO fields changed: %+v", actual)
	}
}

func TestTaskHTTPScopesIDsAndMethods(t *testing.T) {
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	collection := taskCollection(testProjectID)
	path := collection + "/" + testTaskID
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		assertProjectError(t, projectRequest(h, method, taskCollection("invalid-secret-id"), `{"title":"valid"}`), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		assertProjectError(t, projectRequest(h, method, taskCollection("invalid-secret-id")+"/"+testTaskID, `{"version":1,"title":"valid"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(h, method, collection+"/invalid-secret-task", `{"version":1,"title":"valid"}`), http.StatusBadRequest, "invalid_input")
	}
	for target, allow := range map[string]string{collection: "GET, HEAD, POST", path: "GET, HEAD, PATCH, DELETE"} {
		response := projectRequest(h, http.MethodPut, target, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != allow {
			t.Fatalf("wrong Allow: %s", response.Header().Get("Allow"))
		}
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatalf("invalid route called service %d times", h.Tasks.TotalCalls())
	}
	h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: testTask("Head resource"), Epoch: testEpoch}, nil
	}
	h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		return taskservice.TaskPage{Items: []model.Task{}}, nil
	}
	for _, target := range []string{collection, path} {
		response := projectRequest(h, http.MethodHead, target, "")
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("HEAD route: %d %v", response.Code, response.Header())
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("raw path or content leaked: %s", &logs)
	}
	missing := "00000000-0000-4000-8000-000000000099"
	for _, resource := range []struct{ projectID, id string }{{missing, testTaskID}, {"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", testTaskID}, {testProjectID, missing}} {
		for _, method := range []string{http.MethodGet, http.MethodPatch} {
			t.Run(resource.projectID+"/"+resource.id+"/"+method, func(t *testing.T) {
				f := newHTTPFixture(t, io.Discard)
				if method == http.MethodGet {
					f.Tasks.ObserveFunc = func(_ context.Context, _ model.Principal, projectID, id string) (taskservice.TaskObservation, error) {
						if projectID != resource.projectID || id != resource.id {
							t.Fatalf("read scope changed: %s %s", projectID, id)
						}
						return taskservice.TaskObservation{}, &model.Fault{Code: "not_found", Message: "Task was not found."}
					}
				} else {
					f.Tasks.UpdateFunc = func(_ context.Context, _ model.Principal, projectID, id string, _ taskcore.UpdateTask) (model.Task, error) {
						if projectID != resource.projectID || id != resource.id {
							t.Fatalf("update scope changed: %s %s", projectID, id)
						}
						return model.Task{}, &model.Fault{Code: "not_found", Message: "Task was not found."}
					}
				}
				assertProjectError(t, projectRequest(f, method, taskCollection(resource.projectID)+"/"+resource.id, `{"version":1,"title":"changed"}`), http.StatusNotFound, "not_found")
			})
		}
	}
}

func TestTaskHTTPUnavailableCollectionsAndDependencyInputForwarding(t *testing.T) {
	missing := "00000000-0000-4000-8000-000000000099"
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			if method == http.MethodGet {
				h.Tasks.ListFunc = func(_ context.Context, principal model.Principal, projectID string, _ taskservice.TaskListRequest) (taskservice.TaskPage, error) {
					if principal != h.principal || projectID != missing {
						t.Fatalf("missing collection scope: %+v %s", principal, projectID)
					}
					return taskservice.TaskPage{}, &model.Fault{Code: "not_found", Message: "Project was not found."}
				}
			} else {
				h.Tasks.CreateFunc = func(_ context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
					if principal != h.principal || projectID != missing || input.Title != "valid" {
						t.Fatalf("missing create scope: %+v %s %+v", principal, projectID, input)
					}
					return model.Task{}, &model.Fault{Code: "not_found", Message: "Project was not found."}
				}
			}
			assertProjectError(t, projectRequest(h, method, taskCollection(missing), `{"title":"valid"}`), http.StatusNotFound, "not_found")
		})
	}
	for _, references := range [][]string{{testTaskID, testTaskID}, {"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", missing}} {
		t.Run(strings.Join(references, "/"), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.CreateFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
				if !slices.Equal(input.DependsOn, references) {
					t.Fatalf("dependency input was changed: %v", input.DependsOn)
				}
				return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Dependency references are invalid."}
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, taskCollection(testProjectID), jsonBody(t, map[string]any{"title": "Invalid references", "dependsOn": references})), http.StatusBadRequest, "invalid_input")
		})
	}
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.UpdateFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.UpdateTask) (model.Task, error) {
		if input.Version != 9223372036854775807 || input.DependsOn == nil || !slices.Equal(*input.DependsOn, []string{testTaskID}) {
			t.Fatalf("exact version/selfdependency input changed: %+v", input)
		}
		return model.Task{}, &model.Fault{Code: "version_conflict", Message: "Task version changed."}
	}
	assertProjectError(t, projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, jsonBody(t, map[string]any{"version": int64(9223372036854775807), "dependsOn": []string{testTaskID}})), http.StatusConflict, "version_conflict")
}

func TestTaskHTTPListFiltersKeysetsAndCursorScopes(t *testing.T) {
	for _, tc := range []struct {
		query  string
		status model.TaskStatus
		ready  *bool
	}{
		{"status=todo&ready=true", model.TaskTodo, boolPointerHTTP(true)},
		{"status=todo&ready=false", model.TaskTodo, boolPointerHTTP(false)},
		{"status=in_progress&ready=false", model.TaskInProgress, boolPointerHTTP(false)},
		{"status=done", model.TaskDone, nil},
		{"status=done&ready=true", model.TaskDone, boolPointerHTTP(true)},
	} {
		t.Run(tc.query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Filtered task")
			result.Status = tc.status
			cursor := "opaque + / cursor"
			h.Tasks.ListFunc = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || input.Status == nil || *input.Status != tc.status || !reflect.DeepEqual(input.Ready, tc.ready) || input.Limit != 50 || input.Cursor != nil {
					t.Fatalf("list query: %+v", input)
				}
				return taskservice.TaskPage{Items: []model.Task{result}, NextCursor: &cursor}, nil
			}
			page := decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?"+tc.query, ""), http.StatusOK)
			if len(page.Items) != 1 || page.Items[0].ID != result.ID || page.Items[0].Status != string(tc.status) || page.NextCursor == nil || *page.NextCursor != cursor {
				t.Fatalf("list projection: %+v", page)
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	cursor := "opaque + / cursor"
	h.Tasks.ListFunc = func(_ context.Context, _ model.Principal, _ string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		if input.Limit != 1 || input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("cursor forwarding: %+v", input)
		}
		return taskservice.TaskPage{Items: []model.Task{}}, nil
	}
	response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?limit=1&cursor="+url.QueryEscape(cursor), "")
	page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil || !strings.Contains(response.Body.String(), `"items":[]`) || !strings.Contains(response.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty page projection: %s", response.Body)
	}
	f := newHTTPFixture(t, io.Discard)
	for _, query := range []string{"limit=", "limit=0", "limit=101", "limit=x", "limit=1&limit=2", "cursor=", "cursor=x&cursor=y", "status=", "status=todo&status=done", "ready=", "ready=1", "ready=TRUE", "ready=yes", "ready=true&ready=false", "unknown=x", "status=%xx", "ready=true;limit=1"} {
		assertProjectError(t, projectRequest(f, http.MethodGet, taskCollection(testProjectID)+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	if f.Tasks.TotalCalls() != 0 {
		t.Fatalf("query rejection called service %d times", f.Tasks.TotalCalls())
	}
	for _, query := range []string{"cursor=invalid", "status=blocked", "status=proposed"} {
		t.Run("domain_"+query, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			f.Tasks.ListFunc = func(_ context.Context, _ model.Principal, _ string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				if input.Limit != 50 {
					t.Fatalf("domain query input: %+v", input)
				}
				return taskservice.TaskPage{}, &model.Fault{Code: "invalid_input", Message: "Task selection is invalid."}
			}
			assertProjectError(t, projectRequest(f, http.MethodGet, taskCollection(testProjectID)+"?"+query, ""), http.StatusBadRequest, "invalid_input")
		})
	}
}

func boolPointerHTTP(value bool) *bool { return &value }

func TestTaskHTTPOperationalFailuresAndCancellation(t *testing.T) {
	for _, tc := range []struct{ method, suffix, body string }{
		{http.MethodGet, "", ""}, {http.MethodGet, "/" + testTaskID, ""}, {http.MethodPost, "", `{"title":"private-body-secret"}`}, {http.MethodPatch, "/" + testTaskID, `{"version":1,"title":"private-body-secret"}`}, {http.MethodPut, "/" + testTaskID + "/status", `{"version":1,"status":"done"}`},
	} {
		t.Run(tc.method+tc.suffix, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_table_secret SQL driver-secret")}
			switch {
			case tc.method == http.MethodGet && tc.suffix == "":
				h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
					return taskservice.TaskPage{}, failure
				}
			case tc.method == http.MethodGet:
				h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
					return taskservice.TaskObservation{}, failure
				}
			case tc.method == http.MethodPost:
				h.Tasks.CreateFunc = func(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error) {
					return model.Task{}, failure
				}
			case tc.method == http.MethodPatch:
				h.Tasks.UpdateFunc = func(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error) {
					return model.Task{}, failure
				}
			default:
				h.Tasks.SetStatusFunc = func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error) {
					return model.Task{}, failure
				}
			}
			response := projectRequest(h, tc.method, taskCollection(testProjectID)+tc.suffix, tc.body)
			assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
			if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "SQL") || strings.Contains(response.Body.String(), "database") || strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"component":"task"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
				t.Fatalf("operational error leaked or lost classification: body=%s logs=%s", response.Body, &logs)
			}
		})
	}
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	entered, exited := make(chan struct{}), make(chan struct{})
	h.Tasks.UpdateFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
		if principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.Title == nil || *input.Title != "canceled-update" {
			t.Errorf("canceled update input: %+v", input)
		}
		close(entered)
		<-ctx.Done()
		close(exited)
		return model.Task{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, strings.NewReader(`{"version":1,"title":"canceled-update"}`)).WithContext(ctx)
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	response, finished := httptest.NewRecorder(), make(chan struct{})
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("canceled HTTP update did not drain")
		}
	})
	go func() { h.ServeHTTP(response, request); close(finished) }()
	await(t, entered)
	cancel()
	await(t, exited)
	await(t, finished)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled update response: body=%s logs=%s", response.Body, &logs)
	}
}

func TestTaskHTTPKnownFaultsPreserveOperationalPrecedence(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, err := range []error{
		&model.Fault{Code: "unknown", Message: "unknown-secret"},
		errors.Join(&model.Fault{Code: "not_found", Message: "domain-secret"}, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("driver-secret")}),
		errors.Join(&model.Fault{Code: "not_found", Message: "domain-secret"}, context.Canceled),
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			httpx.WriteError(w, request, logger, "task", "get", err)
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
	for _, handler := range []http.HandlerFunc{
		func(w http.ResponseWriter, request *http.Request) {
			httpx.WriteCreated(w, request, logger, "/unwritten", api.Task{})
		},
		httpx.MethodNotAllowed(logger, "GET, HEAD"),
	} {
		response := httptest.NewRecorder()
		handler(response, request)
		if len(response.Header()) != 0 || response.Body.Len() != 0 {
			t.Fatalf("canceled response changed headers or body: %+v %s", response.Header(), response.Body)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("unknown fault diagnostics leaked: %s", &logs)
	}
}
