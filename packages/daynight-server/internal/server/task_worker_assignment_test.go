package server

import (
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWorkerHTTPClaimRequiresAuthenticatedAssignee(t *testing.T) {
	f := newTaskHTTPFixture(t)
	other := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, assigned := range []*string{nil, &other, &f.principal.UserID} {
		current := workerHTTPTask(t)
		current.Title, current.AssignedTo = "Worker assignment eligibility", assigned
		path := taskCollection(current.ProjectID) + "/" + current.ID
		body := workerClaimBody(current.Version)
		var returned model.Task
		if assigned == nil || *assigned != f.principal.UserID {
			plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, nil, model.Task{}, nil)
			assertProjectError(t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusConflict, "invalid_transition")
			plan.check()
			f.expectRead(current)
			actual := readHTTPTask(t, f.handler, api.Task{ID: current.ID, ProjectID: current.ProjectID})
			expected := api.Task{ID: current.ID, Type: current.Type, ParentID: current.ParentID, ProjectID: current.ProjectID, Title: current.Title, Description: current.Description,
				Status: "todo", Version: current.Version, CreatedAt: current.CreatedAt, UpdatedAt: current.UpdatedAt,
				Properties: api.TaskProperties{}, AssignedTo: assigned, AllowAgents: true, Ready: true,
				DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatal("rejected automatic claim changed task facts")
			}
			continue
		}
		claimedAt := current.UpdatedAt.Add(time.Second)
		worker := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
			Machine: model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"}, Platform: model.PlatformLinux,
			Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string),
			State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
		returned = current
		returned.Status, returned.Version, returned.Ready = model.TaskInProgress, current.Version+1, false
		returned.StartedAt, returned.UpdatedAt = &claimedAt, claimedAt
		returned.Properties = workerHTTPProperties(t, current.Properties, &worker)
		values := workerHTTPWriteValues(returned)
		plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, returned, &claimedAt)
		claimed := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusOK)
		plan.check()
		if claimed.Status != "in_progress" || !reflect.DeepEqual(claimed.AssignedTo, assigned) || apiWorker(t, claimed.Properties).UserID != f.principal.UserID {
			t.Fatalf("claim did not use authenticated assignee: %#v", claimed)
		}
	}
}
