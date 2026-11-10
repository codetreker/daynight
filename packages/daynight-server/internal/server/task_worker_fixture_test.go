package server

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func workerClaimBody(version int64) map[string]any {
	return map[string]any{"version": version, "claimId": uuid.NewString(), "workerId": uuid.NewString(),
		"machine": map[string]any{"id": uuid.NewString(), "name": "Worker machine"}, "platform": "linux", "agent": "codex", "worktreeId": uuid.NewString()}
}

func createHTTPWorkerTask(t *testing.T, handler *resourceTestHandler, projectID, title string, dependencies ...string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(projectID), jsonBody(t, map[string]any{
		"title": title, "description": "initial description", "status": "todo", "dependsOn": append([]string{}, dependencies...), "assignedTo": handler.principal.UserID,
	})), http.StatusCreated)
}

func claimHTTPWorker(t *testing.T, handler http.Handler, task api.Task, body map[string]any) api.Task {
	t.Helper()
	body["version"] = task.Version
	response := projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("worker claim response can be cached")
	}
	return decodeResponse[api.Task](t, response, http.StatusOK)
}
