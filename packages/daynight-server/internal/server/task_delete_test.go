package server

import (
	"bytes"
	"context"
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
