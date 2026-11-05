package session_test

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func taskProject(t *testing.T, handler http.Handler) api.Project {
	t.Helper()
	return decodeResponse[api.Project](t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Task project", RepoURL: "https://github.com/example/tasks", ExpectedUserID: handler.(*resourceTestHandler).principal.UserID})), http.StatusCreated)
}

func taskCollection(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }

func taskPath(task api.Task) string { return taskCollection(task.ProjectID) + "/" + task.ID }

func createHTTPTask(t *testing.T, handler http.Handler, projectID, title string, dependencies ...string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(projectID), jsonBody(t, map[string]any{
		"title": title, "description": "initial description", "dependsOn": append([]string{}, dependencies...),
	})), http.StatusCreated)
}

func updateHTTPTask(t *testing.T, handler http.Handler, task api.Task, values map[string]any) api.Task {
	t.Helper()
	values["version"] = task.Version
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, values)), http.StatusOK)
}

func setHTTPTask(t *testing.T, handler http.Handler, task api.Task, status string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status",
		jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})), http.StatusOK)
}

func readHTTPTask(t *testing.T, handler http.Handler, task api.Task) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskPath(task), ""), http.StatusOK)
}
