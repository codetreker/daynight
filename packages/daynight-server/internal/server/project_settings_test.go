package server

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
)

func TestProjectSettingsProjectionAcrossRootRoutes(t *testing.T) {
	transactions := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, transactions, &logs)
	minimum := projectHTTPRecord("a0000000-0000-4000-8000-000000000001", "Settings", "https://example.com/settings.git", "00000000-0000-4000-8000-000000000101")
	minimum.Settings = model.ProjectSettings{Version: 9007199254740995, ExecutionWarningMinutes: 1}
	otherModel := projectHTTPRecord("a0000000-0000-4000-8000-000000000002", "Independent settings", "https://example.com/other.git", minimum.Ownership.TeamID)
	updated, other := projecthttp.ProjectResponse(minimum), projecthttp.ProjectResponse(otherModel)
	projectHTTPGet(t, transactions, handler.principal, minimum)
	read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+minimum.ID, ""), http.StatusOK)
	settingsHTTPProjectList(t, transactions, handler.principal, minimum, otherModel)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	const taskID = "00000000-0000-4000-8000-000000000201"
	settingsHTTPGraph(t, transactions, handler.principal, minimum, taskID)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(minimum.ID, taskID), ""), http.StatusOK)
	if read != updated || graph.Project != updated || len(page.Items) != 2 || page.Items[0] != updated || page.Items[1] != other {
		t.Fatalf("settings differ across project/get/list/graph resources: project %+v, page %+v, graph %+v", read, page, graph.Project)
	}
	projectHTTPGet(t, transactions, handler.principal, otherModel)
	if readOther := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+other.ID, ""), http.StatusOK); readOther != other {
		t.Fatal("independent project settings changed")
	}
}
