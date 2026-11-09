package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPIncludeSessionUsesObservationAndEncodesSession(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Observations.GetFunc = func(ctx context.Context, p model.Principal, project, id string) (service.ObservedTask, error) {
		if p != testPrincipal() || project != testProjectID || id != testTaskID {
			t.Fatal("wrong observation scope")
		}
		return service.ObservedTask{Task: testTask("Observed"), Epoch: testEpoch, Session: sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_registered", Reason: "not_registered"}}, nil
	}
	response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID+"?include=session", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["session"] == nil || fields["title"] == nil || response.Header().Get("Daynight-Task-Epoch") != testEpoch {
		t.Fatalf("lost projection fields: %s", response.Body.String())
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatal("observation invoked ordinary task use case")
	}
}
func TestTaskHTTPWorkArgumentsAndEnvelopeBudget(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Observations.WorkFunc = func(_ context.Context, p model.Principal, project string, input taskcore.WorkRequest) (taskwork.Page, error) {
		if p != testPrincipal() || project != testProjectID || input.Limit != 7 || input.AssignedTo == nil || *input.AssignedTo != "me" || input.ResponseOverhead != 1 {
			t.Fatalf("work input %#v", input)
		}
		return taskwork.Page{Groups: []taskwork.Group{}, ObservedAt: testTime}, nil
	}
	response := projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-work?assignedTo=me&limit=7", "")
	if response.Code != http.StatusOK || response.Body.Len() > taskwork.MaxResponseBytes || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("work response: %d %s", response.Code, response.Body.String())
	}
}
func TestTaskHTTPInvalidIncludeDoesNotInvokeBusiness(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	for _, path := range []string{taskCollection(testProjectID) + "?include=history", taskCollection(testProjectID) + "/" + testTaskID + "?include=history", "/api/v1/projects/" + testProjectID + "/task-graph?taskId=" + testTaskID + "&include=history"} {
		r := projectRequest(h, http.MethodGet, path, "")
		if r.Code != 400 {
			t.Fatalf("%s: %d", path, r.Code)
		}
	}
	if h.Tasks.TotalCalls() != 0 || h.Observations.TotalCalls() != 0 {
		t.Fatal("invalid query reached business")
	}
}

func TestTaskHTTPObservedWorkerInventoryKeepsLegacyProtocolRefusal(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	task, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeWeb, model.WorkerActive)
	h.Observations.ListFunc = func(context.Context, model.Principal, string, service.TaskListRequest) (service.ObservedTaskPage, error) {
		return service.ObservedTaskPage{Items: []service.ObservedTask{{Task: task}}, ObservedAt: testTime}, nil
	}
	response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?include=session&workerId="+testUserID, "")
	if response.Code != http.StatusConflict {
		t.Fatalf("legacy inventory lost refusal: %d %s", response.Code, response.Body.String())
	}
}

func TestTaskHTTPObservedListAndGraphPreservePartialAndRelations(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	observed := sp.TaskSessionObservation{SchemaVersion: 1, Observation: "unavailable", Registration: "unknown", Reason: "execution_changed"}
	cursor := "next-page"
	h.Observations.ListFunc = func(_ context.Context, p model.Principal, project string, input service.TaskListRequest) (service.ObservedTaskPage, error) {
		if p != testPrincipal() || project != testProjectID || input.Limit != 2 {
			t.Fatal("wrong list scope")
		}
		return service.ObservedTaskPage{Items: []service.ObservedTask{{Task: testTask("partial"), Session: observed}}, NextCursor: &cursor, ObservedAt: testTime, Partial: true}, nil
	}
	list := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?include=session&limit=2", "")
	var page struct {
		Items []struct {
			ID      string                    `json:"id"`
			Session sp.TaskSessionObservation `json:"session"`
		} `json:"items"`
		NextCursor *string `json:"nextCursor"`
		Partial    bool    `json:"partial"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil || list.Code != 200 || len(page.Items) != 1 || page.Items[0].ID != testTaskID || page.Items[0].Session.Reason != "execution_changed" || !page.Partial || page.NextCursor == nil || *page.NextCursor != cursor {
		t.Fatalf("list projection: %s %v", list.Body.String(), err)
	}
	h.Observations.GraphFunc = func(_ context.Context, p model.Principal, project, id string) (service.ObservedGraph, error) {
		if p != testPrincipal() || project != testProjectID || id != testTaskID {
			t.Fatal("wrong graph scope")
		}
		return service.ObservedGraph{Graph: model.TaskGraph{Project: testProject(), ObservedAt: testTime, Tasks: []model.GraphTask{{ID: testTaskID, Status: model.TaskInProgress, DependsOn: []string{testUserID}, ExternalDependsOn: []string{testUserID}}, {ID: testUserID, Status: model.TaskInProgress}}}, Sessions: map[string]sp.TaskSessionObservation{testTaskID: observed, testUserID: observed}, Relations: map[string]string{testTaskID: "member", testUserID: "external"}, Aggregation: taskwork.Aggregation{UnknownCount: 1, Complete: false, ObservedAt: testTime}, Partial: true}, nil
	}
	graph := projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-graph?taskId="+testTaskID+"&include=session", "")
	var body struct {
		Tasks []struct {
			ID       string                    `json:"id"`
			Relation string                    `json:"relation"`
			Session  sp.TaskSessionObservation `json:"session"`
		} `json:"tasks"`
		Partial        bool                 `json:"partial"`
		SessionSummary taskwork.Aggregation `json:"sessionSummary"`
	}
	if err := json.Unmarshal(graph.Body.Bytes(), &body); err != nil || graph.Code != 200 || len(body.Tasks) != 2 || body.Tasks[0].Relation != "member" || body.Tasks[1].Relation != "external" || body.Tasks[0].Session.Reason != "execution_changed" || !body.Partial || body.SessionSummary.UnknownCount != 1 {
		t.Fatalf("graph projection: %s %v", graph.Body.String(), err)
	}
}

func TestTaskHTTPObservedLegacyCandidatesContinuePastIncompatiblePage(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	incompatible, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeWeb, model.WorkerActive)
	h.Observations.ExpectCalls("ObserveList", 2)
	cursor := "next-compatible-page"
	calls := 0
	h.Observations.ListFunc = func(_ context.Context, _ model.Principal, _ string, input service.TaskListRequest) (service.ObservedTaskPage, error) {
		calls++
		if calls == 1 {
			return service.ObservedTaskPage{Items: []service.ObservedTask{{Task: incompatible}}, NextCursor: &cursor, ObservedAt: testTime}, nil
		}
		if calls != 2 || input.Cursor == nil || *input.Cursor != cursor {
			t.Fatal("incorrect legacy continuation")
		}
		return service.ObservedTaskPage{Items: []service.ObservedTask{{Task: testTask("compatible")}}, ObservedAt: testTime}, nil
	}
	result := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?include=session&ready=true&allowAgents=true&compatiblePlatform=macos", "")
	if result.Code != 200 || calls != 2 {
		t.Fatalf("legacy candidates: %d %s calls=%d", result.Code, result.Body.String(), calls)
	}
}

func TestTaskHTTPObservationCancellationReachesUseCase(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, finished := make(chan struct{}), make(chan struct{})
	h.Observations.GetFunc = func(ctx context.Context, _ model.Principal, _, _ string) (service.ObservedTask, error) {
		close(started)
		<-ctx.Done()
		return service.ObservedTask{}, ctx.Err()
	}
	request := httptest.NewRequest(http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID+"?include=session", nil).WithContext(ctx)
	authorizeResourceRequest(h, request)
	response := httptest.NewRecorder()
	go func() { defer close(finished); h.ServeHTTP(response, request) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("observation did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("observation did not release cancelled request")
	}
	if response.Body.Len() != 0 || h.Observations.Calls("ObserveGet") != 1 {
		t.Fatalf("cancelled observation published success: %d %s", response.Code, response.Body.String())
	}
}

func TestTaskHTTPObservationRefusalsAndWorkInputErrors(t *testing.T) {
	for _, operation := range []string{"get", "list", "graph", "work"} {
		t.Run(operation, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			failure := &model.Fault{Code: "forbidden", Message: "Project membership revoked."}
			path := taskCollection(testProjectID) + "?include=session"
			switch operation {
			case "get":
				path = taskCollection(testProjectID) + "/" + testTaskID + "?include=session"
				h.Observations.GetFunc = func(context.Context, model.Principal, string, string) (service.ObservedTask, error) {
					return service.ObservedTask{}, failure
				}
			case "list":
				h.Observations.ListFunc = func(context.Context, model.Principal, string, service.TaskListRequest) (service.ObservedTaskPage, error) {
					return service.ObservedTaskPage{}, failure
				}
			case "graph":
				path = "/api/v1/projects/" + testProjectID + "/task-graph?taskId=" + testTaskID + "&include=session"
				h.Observations.GraphFunc = func(context.Context, model.Principal, string, string) (service.ObservedGraph, error) {
					return service.ObservedGraph{}, failure
				}
			case "work":
				path = "/api/v1/projects/" + testProjectID + "/task-work"
				h.Observations.WorkFunc = func(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error) {
					return taskwork.Page{}, failure
				}
			}
			assertProjectError(t, projectRequest(h, http.MethodGet, path, ""), http.StatusForbidden, "forbidden")
		})
	}
	for _, query := range []string{"limit=0", "limit=51", "limit=no", "limit=1&limit=2", "unknown=true"} {
		t.Run(query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			r := projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-work?"+query, "")
			if r.Code != 400 || h.Observations.TotalCalls() != 0 {
				t.Fatalf("invalid work request: %d %s", r.Code, r.Body.String())
			}
		})
	}
}
