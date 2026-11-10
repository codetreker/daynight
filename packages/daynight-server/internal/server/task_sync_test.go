package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func TestTaskSyncHTTPAuthenticationAndProjectMembership(t *testing.T) {
	project, _, admin := taskHTTPMockModels()
	path := syncPath(project.ID)
	unauthenticated := newTaskHTTPFixture(t)
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	unauthenticated.handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")

	outsider := admin
	outsider.UserID = "aaaaaa77-7777-4777-8777-777777777777"
	outsider.CredentialID = "bbbbbb88-8888-4888-8888-888888888888"
	outside := newTaskHTTPFixtureForPrincipal(t, outsider)
	outside.expectSyncRequest(taskservice.TaskSyncRequest{}, model.TaskSync{}, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	assertProjectError(t, projectRequest(outside.handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")

	f := newTaskHTTPFixture(t)
	f.expectSyncRequest(taskservice.TaskSyncRequest{}, model.TaskSync{Mode: "snapshot", Epoch: "cccccc99-9999-4999-8999-999999999999", Project: project, ActorAccess: taskHTTPMockAccess(project, admin), ObservedAt: project.UpdatedAt, Tasks: []model.TaskViewRecord{}, AssigneeVersions: []model.TaskAssigneeVersion{}, Sessions: map[string]model.SessionListState{}}, nil)
	result := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, path, ""), http.StatusOK)
	if result.Project.ID != project.ID || result.Tasks == nil {
		t.Fatalf("authorized project snapshot: %#v", result)
	}
}
