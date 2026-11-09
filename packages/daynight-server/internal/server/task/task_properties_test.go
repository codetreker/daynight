package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPPropertiesRoundTripAndMutationSemantics(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		properties model.TaskProperties
	}{
		{"omitted", `{"title":"Default"}`, model.TaskProperties{}},
		{"empty patch", `{"title":"Default","properties":{}}`, model.TaskProperties{}},
		{"present empty array", `{"title":"Default","properties":{"pullRequests":[]}}`, model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Default")
			result.Properties = tc.properties
			h.Tasks.CreateFunc = func(ctx context.Context, p model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, testTaskID)
				if input.Title != "Default" || !reflect.DeepEqual(input.Properties, tc.properties) {
					t.Fatalf("create properties changed: %#v", input)
				}
				return result, nil
			}
			actual := decodeResponse[api.Task](t, projectRequest(h, http.MethodPost, taskCollection(testProjectID), tc.body), http.StatusCreated)
			if actual.Properties == nil || !reflect.DeepEqual(model.TaskProperties(actual.Properties), tc.properties) {
				t.Fatalf("empty property presence changed: %#v", actual.Properties)
			}
		})
	}

	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	body := `{"title":"References","properties":{"pullRequests":[{"url":"","title":""},{"url":"  acceptance-secret arbitrary\u0000\n地址  ","title":"\t标题\u0000"},{"title":"\t标题\u0000","url":"  acceptance-secret arbitrary\u0000\n地址  "},{"url":"https://EXAMPLE.com/a","title":"\ud800"}]}}`
	want := []api.PullRequestProperty{{URL: "", Title: ""}, {URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"}, {URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"}, {URL: "https://EXAMPLE.com/a", Title: "\ufffd"}}
	result := testTask("References")
	result.Properties = model.TaskProperties{"pullRequests": rawProperty(t, want)}
	h.Tasks.CreateFunc = func(ctx context.Context, p model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
		requirePropertyCall(t, ctx, p, projectID, testTaskID)
		var got []api.PullRequestProperty
		if err := json.Unmarshal(input.Properties["pullRequests"], &got); err != nil || !slices.Equal(got, want) {
			t.Fatalf("JSON property strings/order/duplicates changed: %#v %v", got, err)
		}
		return result, nil
	}
	created := decodeResponse[api.Task](t, projectRequest(h, http.MethodPost, taskCollection(testProjectID), body), http.StatusCreated)
	if !slices.Equal(apiPullRequests(t, created.Properties), want) {
		t.Fatalf("property response changed decoded strings: %#v", created)
	}

	reordered := slices.Clone(want)
	slices.Reverse(reordered)
	for _, tc := range []struct {
		name, body         string
		properties         model.TaskPropertiesPatch
		title, description *string
		result             model.Task
	}{
		{"empty property patch", `{"version":1,"title":"Renamed","properties":{}}`, model.TaskPropertiesPatch{}, propertyString("Renamed"), nil, result},
		{"omitted properties", `{"version":1,"description":"Old client update"}`, nil, nil, propertyString("Old client update"), result},
		{"explicit empty array", `{"version":1,"properties":{"pullRequests":[]}}`, model.TaskPropertiesPatch{"pullRequests": json.RawMessage(`[]`)}, nil, nil, propertyResult(result, model.TaskProperties{"pullRequests": json.RawMessage(`[]`)})},
		{"reordered array", jsonBody(t, map[string]any{"version": 1, "properties": map[string]any{"pullRequests": reordered}}), model.TaskPropertiesPatch{"pullRequests": rawProperty(t, reordered)}, nil, nil, propertyResult(result, model.TaskProperties{"pullRequests": rawProperty(t, reordered)})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newHTTPFixture(t, io.Discard)
			fixture.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				if input.Version != result.Version || !reflect.DeepEqual(input.Properties, tc.properties) || !reflect.DeepEqual(input.Title, tc.title) || !reflect.DeepEqual(input.Description, tc.description) {
					t.Fatalf("patch presence changed: %#v", input)
				}
				return tc.result, nil
			}
			actual := decodeResponse[api.Task](t, projectRequest(fixture, http.MethodPatch, propertyTaskPath(result), tc.body), http.StatusOK)
			if !reflect.DeepEqual(model.TaskProperties(actual.Properties), tc.result.Properties) {
				t.Fatalf("patch result changed service properties: %#v", actual)
			}
		})
	}
	h.Tasks.ListFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		requirePropertyCall(t, ctx, p, projectID, testTaskID)
		if input.Limit != 100 {
			t.Fatalf("list limit changed: %#v", input)
		}
		return taskservice.TaskPage{Items: []model.Task{result}}, nil
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?limit=100", ""), http.StatusOK)
	if len(page.Items) != 1 || !slices.Equal(apiPullRequests(t, page.Items[0].Properties), want) {
		t.Fatal("task list dropped full properties")
	}
	if strings.Contains(logs.String(), "acceptance-secret") || strings.Contains(logs.String(), "标题") {
		t.Fatalf("property values leaked to logs: %s", &logs)
	}
}

func propertyString(value string) *string { return &value }
func propertyResult(task model.Task, values model.TaskProperties) model.Task {
	task.Properties = values
	return task
}

func propertyExtendedRequest(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Daynight-Worker-Protocol", "2")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func TestTaskHTTPPatchPausePreservesActiveWorkerAcrossConflict(t *testing.T) {
	task := propertyHTTPActiveTask(t)
	for _, value := range []bool{true, false} {
		t.Run(map[bool]string{true: "pause", false: "unpause"}[value], func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			expected := maps.Clone(task.Properties)
			expected["paused"] = rawProperty(t, value)
			result := propertyResult(task, expected)
			h.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
				requirePropertyCall(t, ctx, p, projectID, id)
				want := model.TaskPropertiesPatch{"paused": rawProperty(t, value)}
				if input.Version != task.Version || input.Properties == nil || !reflect.DeepEqual(input.Properties, want) {
					t.Fatalf("pause patch changed: %#v", input)
				}
				return result, nil
			}
			response := propertyExtendedRequest(h, http.MethodPatch, propertyTaskPath(task), jsonBody(t, map[string]any{"version": task.Version, "properties": map[string]any{"paused": value}}))
			actual := decodeResponse[api.Task](t, response, http.StatusOK)
			if !reflect.DeepEqual(model.TaskProperties(actual.Properties), expected) || actual.Status != string(task.Status) || !reflect.DeepEqual(actual.StartedAt, task.StartedAt) {
				t.Fatalf("pause response changed service execution data: %#v", actual)
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
		requirePropertyCall(t, ctx, p, projectID, id)
		if input.Version != task.Version || input.Properties == nil || string(input.Properties["paused"]) != "false" {
			t.Fatalf("stale pause input changed: %#v", input)
		}
		return model.Task{}, &model.Fault{Code: "version_conflict", Message: "Task changed."}
	}
	assertProjectError(t, projectRequest(h, http.MethodPatch, propertyTaskPath(task), jsonBody(t, map[string]any{"version": task.Version, "properties": map[string]any{"paused": false}})), http.StatusConflict, "version_conflict")
}

func TestTaskHTTPPropertiesRejectInvalidStructure(t *testing.T) {
	for _, properties := range []string{
		`null`, `[]`, `"text"`, `true`, `1`, `{"unknown":[]}`, `{"pullRequests":[],"pullRequests":[]}`, `{"pullRequests":[],"pull\u0052equests":[]}`,
		`{"pullRequests":null}`, `{"pullRequests":{}}`, `{"pullRequests":"text"}`, `{"pullRequests":true}`,
		`{"pullRequests":[null]}`, `{"pullRequests":[[]]}`, `{"pullRequests":["text"]}`, `{"pullRequests":[1]}`, `{"pullRequests":[false]}`,
		`{"pullRequests":[{}]}`, `{"pullRequests":[{"url":"x"}]}`, `{"pullRequests":[{"title":"x"}]}`,
		`{"pullRequests":[{"url":null,"title":"x"}]}`, `{"pullRequests":[{"url":"x","title":null}]}`,
		`{"pullRequests":[{"url":1,"title":"x"}]}`, `{"pullRequests":[{"url":"x","title":[]}]}`,
		`{"pullRequests":[{"url":"x","title":"y","state":"open"}]}`, `{"pullRequests":[{"url":"x","title":"y","url":"z"}]}`, `{"pullRequests":[{"url":"x","title":"y","ti\u0074le":"z"}]}`,
	} {
		t.Run(properties, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, taskCollection(testProjectID), `{"title":"Rejected","properties":`+properties+`}`), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(h, http.MethodPatch, propertyTaskPath(testTask("Original")), `{"version":1,"title":"Rejected","properties":`+properties+`}`), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid property structure reached service")
			}
		})
	}
}

func TestTaskHTTPCorruptPropertiesFailWithoutFallback(t *testing.T) {
	for _, corrupt := range []struct{ name, value string }{
		{"pullRequests", `not JSON`}, {"pullRequests", `{}`}, {"pullRequests", `null`}, {"pullRequests", `[{"url":"x"}]`}, {"pullRequests", `[{"url":"x","url":"x","title":"y"}]`}, {"unknown", `1`},
	} {
		t.Run(corrupt.name+"/"+corrupt.value, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			cause := &model.Fault{Code: "invalid_input", Message: "Stored property is invalid."}
			h.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
				return taskservice.TaskObservation{}, cause
			}
			h.Tasks.GetFunc = func(context.Context, model.Principal, string, string) (model.Task, error) { return model.Task{}, cause }
			h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				return taskservice.TaskPage{}, cause
			}
			h.Tasks.UpdateFunc = func(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error) {
				return model.Task{}, cause
			}
			h.Tasks.SetPropertyFunc = func(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error) {
				return model.Task{}, cause
			}
			h.Tasks.RemovePropertyFunc = func(context.Context, model.Principal, string, string, string, int64) (model.Task, error) {
				return model.Task{}, cause
			}
			path := propertyTaskPath(testTask("Original"))
			for _, target := range []string{path, taskCollection(testProjectID), path + "/properties"} {
				assertProjectError(t, projectRequest(h, http.MethodGet, target, ""), http.StatusBadRequest, "invalid_input")
			}
			assertProjectError(t, projectRequest(h, http.MethodPatch, path, `{"version":1,"title":"Rejected"}`), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(h, http.MethodPut, path+"/properties/pullRequests", `{"version":1,"valueText":"[]"}`), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(h, http.MethodDelete, path+"/properties/pullRequests", `{"version":1}`), http.StatusBadRequest, "invalid_input")
		})
	}
}
