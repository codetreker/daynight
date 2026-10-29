package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func propertyResourcePath(task api.Task) string { return taskPath(task) + "/properties" }

func setPropertyBody(t *testing.T, task api.Task, property, value string) string {
	t.Helper()
	return jsonBody(t, api.SetTaskPropertyRequest{Version: task.Version, Property: property, Value: value})
}

func removePropertyBody(t *testing.T, task api.Task, property string) string {
	t.Helper()
	return jsonBody(t, api.RemoveTaskPropertyRequest{Version: task.Version, Property: property})
}

func TestTaskPropertyResourcesRoundTripAndVersionSemantics(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Property resources")
	path := propertyResourcePath(task)
	read := projectRequest(handler, http.MethodGet, path, "")
	initial := decodeResponse[api.TaskPropertiesResource](t, read, http.StatusOK)
	if initial.Version != "1" || !reflect.DeepEqual(initial.Properties, task.Properties) || read.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("property resource omitted its version or full properties: %#v", initial)
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "worker.signaling", "attention")), http.StatusBadRequest, "invalid_input")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	const version = int64(9007199254740993)
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET version=$1 WHERE id=$2", version, task.ID); err != nil {
		t.Fatal(err)
	}
	task.Version = version
	for _, value := range []string{"attention secret中文\n\x00", "123", "null", "[]", `"unfinished`, " ", ""} {
		quoted, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		response := projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "worker.signaling", value))
		changed := decodeResponse[api.TaskPropertiesResource](t, response, http.StatusOK)
		if changed.Version != strconv.FormatInt(task.Version+1, 10) || changed.Properties.Worker == nil || changed.Properties.Worker.Signaling != value || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("raw string property update failed: %#v", changed)
		}
		stale := task
		task = readHTTPTask(t, handler, task)
		assertProjectError(t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, stale, "worker.signaling", value)), http.StatusConflict, "version_conflict")
		noop := decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "worker.signaling", string(quoted))), http.StatusOK)
		if !reflect.DeepEqual(noop, changed) || !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
			t.Fatal("equivalent JSON string update changed task version or timestamps")
		}
		graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph", ""), http.StatusOK)
		if len(graph.Tasks) != 1 || graph.Tasks[0].WorkerNeedsAttention != (value != "") {
			t.Fatal("property update did not synchronize the attention projection")
		}
	}
	prs := []api.PullRequestProperty{{URL: "opaque\x00", Title: "原样"}, {URL: "opaque\x00", Title: "原样"}}
	encoded, err := json.Marshal(prs)
	if err != nil {
		t.Fatal(err)
	}
	changed := decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "pullRequests", string(encoded))), http.StatusOK)
	if !slices.Equal(changed.Properties.PullRequests, prs) || changed.Properties.Worker.Signaling != "" || changed.Properties.Worker.ClaimID != task.Properties.Worker.ClaimID {
		t.Fatal("array property update did not preserve the worker and exact array values")
	}
	read = projectRequest(handler, http.MethodGet, path, "")
	if got := decodeResponse[api.TaskPropertiesResource](t, read, http.StatusOK); !reflect.DeepEqual(got, changed) {
		t.Fatal("property getter did not return the committed result")
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET version=9223372036854775807 WHERE id=$1", task.ID); err != nil {
		t.Fatal(err)
	}
	read = projectRequest(handler, http.MethodGet, path, "")
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(read.Body.Bytes(), &fields); err != nil || len(fields) != 2 || string(fields["version"]) != `"9223372036854775807"` {
		t.Fatalf("resource envelope lost the exact version string: %s %v", read.Body, err)
	}
	if strings.Contains(logs.String(), "attention secret") || strings.Contains(logs.String(), "原样") {
		t.Fatal("property values leaked into diagnostics")
	}
}

func TestTaskPropertyResourcesRejectInvalidPathsAndValues(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Strict properties"), map[string]any{"allowAgents": true})
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	path := propertyResourcePath(task)
	for _, property := range []string{"", ".", "..", ".worker.signaling", "worker.", "worker..signaling", "worker/signaling", "unknown", "worker.claimId", "worker.agentControlMode", "worker.signaling.extra", "pullRequests.0.url"} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, property, "unchanged")), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, property)), http.StatusBadRequest, "invalid_input")
	}
	for _, value := range []string{"", "invalid JSON", "[", "null", "false", "123", `"[]"`, `{}`, `[{}]`, `[{"url":"x","title":"y","title":"z"}]`} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "pullRequests", value)), http.StatusBadRequest, "invalid_input")
	}
	version := strconv.FormatInt(task.Version, 10)
	for _, body := range []string{
		`null`, `{}`, `{"version":1}`, `{"version":0,"property":"worker.signaling","value":"x"}`, `{"version":"1","property":"worker.signaling","value":"x"}`, `{"version":1.0,"property":"worker.signaling","value":"x"}`, `{"version":9223372036854775808,"property":"worker.signaling","value":"x"}`,
		`{"version":` + version + `,"value":"x"}`, `{"version":` + version + `,"property":null,"value":"x"}`, `{"version":` + version + `,"property":1,"value":"x"}`,
		`{"version":` + version + `,"property":"worker.signaling","value":null}`, `{"version":` + version + `,"property":"worker.signaling","value":1}`, `{"version":` + version + `,"property":"worker.signaling","value":[]}`,
		`{"version":` + version + `,"property":"worker.signaling","value":"x","value":"y"}`, `{"version":` + version + `,"property":"worker.signaling","value":"x","unknown":true}`,
		`{"version":` + version + `,"property":"worker.signaling","value":unquoted}`, `{"version":` + version + `,"property":"worker.signaling","value":"unfinished}`, `{"version":` + version + `,"property":"worker.signaling","value":"x"} {}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path, body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{}`, `{"version":1}`, `{"version":1,"property":null}`, setPropertyBody(t, task, "worker.signaling", "x")} {
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path, body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, "worker")), http.StatusBadRequest, "invalid_input")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("invalid generic property writes changed task state")
	}
}

func TestTaskPropertyResourcesRemoveValuesWithVersionedNoop(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Remove properties")
	path := propertyResourcePath(task)
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, "worker.signaling")), http.StatusBadRequest, "invalid_input")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	for _, property := range []string{"worker.signaling", "pullRequests"} {
		value := "attention"
		if property == "pullRequests" {
			value = `[{"url":"PR","title":"Evidence"}]`
		}
		decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, property, value)), http.StatusOK)
		task = readHTTPTask(t, handler, task)
		stale := task
		removed := decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, property)), http.StatusOK)
		if removed.Version != strconv.FormatInt(task.Version+1, 10) || removed.Properties.Worker == nil || removed.Properties.Worker.Signaling != "" || removed.Properties.PullRequests == nil || len(removed.Properties.PullRequests) != 0 {
			t.Fatalf("property removal did not preserve defaults and required keys: %#v", removed)
		}
		task = readHTTPTask(t, handler, task)
		got := decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		if !reflect.DeepEqual(got, removed) {
			t.Fatal("removed property was retained on the resource getter")
		}
		noop := decodeResponse[api.TaskPropertiesResource](t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, property)), http.StatusOK)
		if !reflect.DeepEqual(noop, removed) || !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
			t.Fatal("repeated property removal changed version or task timing")
		}
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, stale, property)), http.StatusConflict, "version_conflict")
	}
}

func TestTaskPropertyResourcesPreserveFullWorkerAcrossProtocolNegotiation(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Web properties"), map[string]any{"allowAgents": true})
	body := workerClaimBody(task.Version)
	body["agent"], body["agentControlMode"] = "claude", "web"
	task = decodeResponse[api.Task](t, protocolRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body), "2"), http.StatusOK)
	path := propertyResourcePath(task)
	for _, protocol := range []string{"", "1", "2"} {
		got := decodeResponse[api.TaskPropertiesResource](t, protocolRequest(handler, http.MethodGet, path, "", protocol), http.StatusOK)
		if !reflect.DeepEqual(got.Properties, task.Properties) || got.Properties.Worker.Agent != "claude" || got.Properties.Worker.AgentControlMode != "web" {
			t.Fatal("properties resource filtered unsupported worker fields")
		}
	}
	set := setPropertyBody(t, task, "worker.signaling", "attention")
	assertProjectError(t, protocolRequest(handler, http.MethodPut, path, set, ""), http.StatusConflict, "invalid_transition")
	got := decodeResponse[api.TaskPropertiesResource](t, protocolRequest(handler, http.MethodPut, path, set, "2"), http.StatusOK)
	if got.Properties.Worker.Signaling != "attention" || got.Properties.Worker.AgentControlMode != "web" || got.Properties.Worker.Agent != "claude" {
		t.Fatal("property setter lost full worker metadata")
	}
	task.Version++
	got = decodeResponse[api.TaskPropertiesResource](t, protocolRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, "worker.signaling"), "2"), http.StatusOK)
	if got.Properties.Worker.Signaling != "" || got.Properties.Worker.AgentControlMode != "web" {
		t.Fatal("property removal lost full worker metadata")
	}
}

func TestTaskPropertyResourcesRetainAuthenticationMethodsAndResourceFailures(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project, other := taskProject(t, handler), taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Resource lifecycle")
	path := propertyResourcePath(task)
	for _, call := range []struct{ method, body string }{{http.MethodGet, ""}, {http.MethodPut, setPropertyBody(t, task, "pullRequests", "[]")}, {http.MethodDelete, removePropertyBody(t, task, "pullRequests")}} {
		request := httptest.NewRequest(call.method, path, strings.NewReader(call.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
		for _, bad := range []string{"bad-project", "bad-task"} {
			invalidPath := strings.Replace(path, project.ID, bad, 1)
			if bad == "bad-task" {
				invalidPath = strings.Replace(path, task.ID, bad, 1)
			}
			assertProjectError(t, projectRequest(handler, call.method, invalidPath, call.body), http.StatusBadRequest, "invalid_input")
		}
		assertProjectError(t, projectRequest(handler, call.method, strings.Replace(path, project.ID, other.ID, 1), call.body), http.StatusNotFound, "not_found")
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch} {
		response := projectRequest(handler, method, path, `{}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD, PUT, DELETE" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("properties method response lost its cache or allow headers")
		}
	}
	response := projectRequest(handler, http.MethodDelete, taskPath(task), jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if response.Code != http.StatusNoContent {
		t.Fatal("could not delete properties test task")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusGone, "task_deleted")
	assertProjectError(t, projectRequest(handler, http.MethodPut, path, setPropertyBody(t, task, "pullRequests", "[]")), http.StatusGone, "task_deleted")
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, removePropertyBody(t, task, "pullRequests")), http.StatusGone, "task_deleted")
}
