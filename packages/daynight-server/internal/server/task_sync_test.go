package server

import (
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"net/http"
	"testing"
	"time"

	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func TestTaskSyncHTTPAuthenticationAndProjectMembership(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := testLogger()
	taskhttp.TaskSyncRoutes(mux, taskservice.NewTaskSync(h.Database, sessioncore.NewEngine(nil), 10*time.Second).Get, h.Auth, logger, 10*time.Second)
	h.Handler = httpx.RequestLogging(logger, mux)
	path := syncPath(h.project.ID)
	assertProjectError(t, h.call(http.MethodGet, path, "", nil), http.StatusUnauthorized, "unauthenticated")
	assertProjectError(t, h.call(http.MethodGet, path, "", h.outsider), http.StatusNotFound, "not_found")
	result := decodeResponse[api.TaskSync](t, h.call(http.MethodGet, path, "", h.admin), http.StatusOK)
	if result.Project.ID != h.project.ID || result.Tasks == nil {
		t.Fatalf("authorized project snapshot: %#v", result)
	}
}
