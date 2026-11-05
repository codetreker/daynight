package task_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

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
		`{"version":1,"removeDepends":null}`, `{"version":1,"removeDepends":"true"}`,
		`{"version":1,"removeDepends":0}`, `{"version":1,"removeDepends":[]}`, `{"version":1,"removeDepends":{}}`,
		`{"version":1,"RemoveDepends":true}`, `{"version":1,"removeDepends":true,"removeDepends":false}`,
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

func TestTaskHTTPDeletionRequiresExplicitRelationshipRemoval(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	target := createHTTPTask(t, handler, project.ID, "Target")
	source := createHTTPTask(t, handler, project.ID, "Source", target.ID)
	for _, body := range []string{`{"version":1}`, `{"version":1,"removeDepends":false}`} {
		assertProjectError(t, projectRequest(handler, http.MethodDelete, taskPath(target), body), http.StatusConflict, "dependency_unsatisfied")
		if actual := readHTTPTask(t, handler, source); actual.Version != source.Version || len(actual.DependsOn) != 1 || actual.Ready {
			t.Fatal("strict deletion changed its dependent")
		}
	}
	response := projectRequest(handler, http.MethodDelete, taskPath(target), jsonBody(t, api.TaskDeleteRequest{Version: target.Version, RemoveDepends: true}))
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("explicit dependency removal failed: %d %s", response.Code, response.Body)
	}
	actual := readHTTPTask(t, handler, source)
	if actual.Version != source.Version+1 || len(actual.DependsOn) != 0 || len(actual.BlockedBy) != 0 || !actual.Ready {
		t.Fatalf("source did not become ready at its new version: %#v", actual)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskPath(target), ""), http.StatusGone, "task_deleted")
	for _, remove := range []bool{false, true} {
		unreferenced := createHTTPTask(t, handler, project.ID, "Unreferenced")
		response := projectRequest(handler, http.MethodDelete, taskPath(unreferenced), jsonBody(t, api.TaskDeleteRequest{Version: unreferenced.Version, RemoveDepends: remove}))
		if response.Code != http.StatusNoContent {
			t.Fatalf("unreferenced deletion with removeDepends=%v failed: %d %s", remove, response.Code, response.Body)
		}
	}
}
