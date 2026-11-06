package task_test

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskGETReturnsAuthorizedSnapshotEpoch(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Observed")
	other := createHTTPTask(t, handler, project.ID, "Epoch failure")
	var epoch string
	if err := database.Pool.QueryRow(context.Background(), `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, taskPath(task), "")
	got := decodeResponse[api.Task](t, response, http.StatusOK)
	if got.ID != task.ID || got.ProjectID != project.ID || got.Description != task.Description || response.Header().Get("Daynight-Task-Epoch") != epoch || response.Header().Get("Daynight-User-ID") != handler.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("incomplete observation: %#v, %v", got, response.Header())
	}
	missing := projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"/00000000-0000-4000-8000-000000000099", "")
	assertProjectError(t, missing, http.StatusNotFound, "not_found")
	if missing.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatal("missing task exposed an epoch")
	}
	unauthorized := projectRequest(handler.Handler, http.MethodGet, taskPath(task), "")
	if unauthorized.Code != http.StatusUnauthorized || unauthorized.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatalf("unauthenticated response exposed history: %d %v", unauthorized.Code, unauthorized.Header())
	}
	deleted := projectRequest(handler, http.MethodDelete, taskPath(task), jsonBody(t, map[string]any{"version": task.Version}))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body)
	}
	gone := projectRequest(handler, http.MethodGet, taskPath(task), "")
	assertProjectError(t, gone, http.StatusGone, "task_deleted")
	if gone.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatal("deleted task unexpectedly exposed an epoch")
	}
	if _, err := database.Pool.Exec(context.Background(), `ALTER TABLE projects DROP COLUMN task_cache_epoch`); err != nil {
		t.Fatal(err)
	}
	failure := projectRequest(handler, http.MethodGet, taskPath(other), "")
	if failure.Code != http.StatusInternalServerError || failure.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatalf("epoch failure published success: %d %v", failure.Code, failure.Header())
	}
}
