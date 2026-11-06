package task_test

import (
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestThreadHTTPAgentPostPreservesActiveClaim(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPWorkerTask(t, handler, project.ID, "Thread owner"), map[string]any{"allowAgents": true})
	claimed := claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	worker := apiWorker(t, claimed.Properties)
	if worker == nil || worker.State != "active" {
		t.Fatal("fixture did not create an active claim")
	}
	message := decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, threadPath(claimed), jsonBody(t, map[string]any{
		"body": "Agent discussion", "claimId": worker.ClaimID,
	})), http.StatusCreated)
	if !message.Author.Agent || message.Author.UserID != handler.principal.UserID {
		t.Fatalf("agent attribution: %+v", message.Author)
	}
	read := readHTTPTask(t, handler, claimed)
	if !reflect.DeepEqual(read, claimed) || !reflect.DeepEqual(apiWorker(t, read.Properties), worker) {
		t.Fatal("agent post changed task or active worker claim")
	}
	page := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, threadPath(claimed)+"?details=true", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != message.ID || page.Items[0].Author.Execution == nil || page.Items[0].Author.Execution.ClaimID != worker.ClaimID || page.Items[0].Author.Execution.WorkerID != worker.WorkerID {
		t.Fatal("agent post lost verified execution attribution")
	}
}
