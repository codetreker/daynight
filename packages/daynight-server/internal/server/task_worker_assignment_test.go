package server

import (
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestWorkerHTTPClaimRequiresAuthenticatedAssignee(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	other := assignmentHTTPMember(t, database, project.ID)
	for _, assigned := range []*string{nil, &other, &handler.principal.UserID} {
		task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{
			"title": "Worker assignment eligibility", "assignedTo": assigned,
		})), http.StatusCreated)
		task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
		response := projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, workerClaimBody(task.Version)))
		if assigned == nil || *assigned != handler.principal.UserID {
			assertProjectError(t, response, http.StatusConflict, "invalid_transition")
			if actual := readHTTPTask(t, handler, task); !reflect.DeepEqual(actual, task) {
				t.Fatal("rejected automatic claim changed task facts")
			}
			continue
		}
		claimed := decodeResponse[api.Task](t, response, http.StatusOK)
		if claimed.Status != "in_progress" || !reflect.DeepEqual(claimed.AssignedTo, assigned) || apiWorker(t, claimed.Properties).UserID != handler.principal.UserID {
			t.Fatalf("claim did not use the authenticated assignee: %#v", claimed)
		}
	}
}
