package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func TestTaskSyncHTTPAuthenticationAndProjectMembership(t *testing.T) {
	project, _, admin := taskHTTPMockModels()
	path := syncPath(project.ID)
	unauthenticatedStore := newHTTPTestStore(t)
	unauthenticated := resourceTestServer(t, unauthenticatedStore, attachmentTestFiles(t), io.Discard)
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")

	outsider := admin
	outsider.UserID = "aaaaaa77-7777-4777-8777-777777777777"
	outsider.CredentialID = "bbbbbb88-8888-4888-8888-888888888888"
	outsiderStore := newHTTPTestStoreForPrincipal(t, outsider)
	outsiderPlan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1})
	outsiderReader := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "outside project")}
	outsiderReader.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		outsiderPlan.Called("access")
		if actor != outsider || id != project.ID {
			t.Fatalf("outsider access: %#v %s", actor, id)
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	outsiderSnapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "outside snapshot"), ProjectDAOFn: func() store.ProjectReader { return outsiderReader }}
	outsiderStore.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		outsiderPlan.Called("snapshot")
		return read(outsiderSnapshot)
	}
	outsideHandler := resourceTestServerForPrincipal(t, outsiderStore, attachmentTestFiles(t), io.Discard, outsider)
	assertProjectError(t, projectRequest(outsideHandler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")

	database := newHTTPTestStore(t)
	plan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1, "project": 1, "epoch": 1, "size": 1, "tasks": 1, "assignees": 1, "observed": 1, "sessions": 1})
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync project")}
	projects.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		plan.Called("access")
		if actor != admin || id != project.ID {
			t.Fatalf("admin access: %#v %s", actor, id)
		}
		return taskHTTPMockAccess(project, admin), nil
	}
	projects.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
		plan.Called("project")
		if id != project.ID {
			t.Fatalf("project ID = %s", id)
		}
		return project, nil
	}
	tasks := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync task")}
	requireProject := func(id string) {
		t.Helper()
		if id != project.ID {
			t.Fatalf("sync project ID = %s", id)
		}
	}
	tasks.TaskCacheEpochFn = func(ctx context.Context, id string) (string, error) {
		plan.Called("epoch")
		requireProject(id)
		return "cccccc99-9999-4999-8999-999999999999", nil
	}
	tasks.TaskGraphSizeFn = func(ctx context.Context, id string) (store.TaskGraphSize, error) {
		plan.Called("size")
		requireProject(id)
		return store.TaskGraphSize{}, nil
	}
	tasks.TaskSyncTasksFn = func(ctx context.Context, id string, lower *time.Time, preview int) ([]model.TaskViewRecord, error) {
		plan.Called("tasks")
		requireProject(id)
		if lower != nil || preview != 160 {
			t.Fatalf("snapshot query = %#v/%d", lower, preview)
		}
		return []model.TaskViewRecord{}, nil
	}
	tasks.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
		plan.Called("assignees")
		requireProject(id)
		return []model.TaskAssigneeFact{}, nil
	}
	sessions := &taskHTTPSessionReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync sessions")}
	sessions.CurrentTaskSessionSourcesFn = func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
		plan.Called("sessions")
		requireProject(id)
		return []store.TaskSessionSource{}, nil
	}
	snapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync snapshot"),
		ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return tasks }, SessionDAOFn: func() store.SessionReader { return sessions },
		ObservedAtFn: func(context.Context) (time.Time, error) { plan.Called("observed"); return project.UpdatedAt, nil },
	}
	database.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		return read(snapshot)
	}
	handler := resourceTestServer(t, database, attachmentTestFiles(t), io.Discard)
	result := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if result.Project.ID != project.ID || result.Tasks == nil {
		t.Fatalf("authorized project snapshot: %#v", result)
	}
}
