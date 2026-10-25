package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPSoftDeletionAndGoneResources(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Private deleted body")
	path := taskPath(task)
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, `{"version":2}`), http.StatusConflict, "version_conflict")
	response := projectRequest(handler, http.MethodDelete, path, jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("delete result: %d %s %v", response.Code, response.Body, response.Header())
	}
	for _, call := range []struct{ method, suffix, body string }{
		{http.MethodGet, "", ""},
		{http.MethodDelete, "", `{"version":2}`},
		{http.MethodPatch, "", `{"version":2,"title":"Changed"}`},
		{http.MethodPut, "/status", `{"version":2,"status":"done"}`},
		{http.MethodGet, "/attachments", ""},
		{http.MethodGet, "/attachments/files/evidence.txt", ""},
		{http.MethodGet, "/preview/evidence.txt", ""},
	} {
		assertProjectError(t, projectRequest(handler, call.method, path+call.suffix, call.body), http.StatusGone, "task_deleted")
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID), ""), http.StatusOK)
	if len(page.Items) != 0 {
		t.Fatal("deleted task is still listed")
	}
	var retained, deleted bool
	if err := database.Pool.QueryRow(context.Background(), "SELECT true,deleted_at IS NOT NULL FROM tasks WHERE id=$1", task.ID).Scan(&retained, &deleted); err != nil || !retained || !deleted {
		t.Fatalf("deletion did not retain marked record: %v", err)
	}
	if !strings.Contains(logs.String(), `"phase":"delete"`) || !strings.Contains(logs.String(), `"cause":"task_deleted"`) || strings.Contains(logs.String(), task.Title) {
		t.Fatalf("missing or unsafe deletion diagnostics: %s", &logs)
	}
}

func TestTaskHTTPDeletionStrictInputAndDependencyRefusal(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Preserved")
	path := taskPath(task)
	for _, body := range []string{
		"", "null", "[]", "{", `{}`, `{"version":null}`, `{"version":0}`, `{"version":-1}`,
		`{"version":"1"}`, `{"version":true}`, `{"version":1.0}`, `{"version":1e0}`,
		`{"version":9223372036854775808}`, `{"Version":1}`, `{"version":1,"version":1}`,
		`{"version":1,"title":"Changed"}`, `{"version":1} {}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path, body), http.StatusBadRequest, "invalid_input")
	}
	for _, query := range []string{"", "version=1", "unknown=secret"} {
		assertProjectError(t, projectRequest(handler, http.MethodDelete, path+"?"+query, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodDelete, taskCollection("invalid")+"/"+task.ID, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(handler, http.MethodDelete, taskCollection(project.ID)+"/invalid", `{"version":1}`), http.StatusBadRequest, "invalid_input")
	dependent := createHTTPTask(t, handler, project.ID, "Dependent", task.ID)
	response := projectRequest(handler, http.MethodDelete, path, `{"version":1}`)
	assertProjectError(t, response, http.StatusConflict, "dependency_unsatisfied")
	body := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
	if body.Error.Details == nil || len(body.Error.Details.TaskIDs) != 1 || body.Error.Details.TaskIDs[0] != dependent.ID {
		t.Fatalf("dependency refusal lacks affected task: %s", response.Body)
	}
	if got := readHTTPTask(t, handler, task); got.Version != task.Version || got.Title != task.Title {
		t.Fatal("refused deletion changed the task")
	}
}
