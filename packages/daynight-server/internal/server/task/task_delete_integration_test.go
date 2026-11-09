package task_test

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPDeletionStrictInputAndDependencyRefusal(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	path := taskCollection(testProjectID) + "/" + testTaskID
	for _, body := range []string{
		"", "null", "[]", "{", `{}`, `{"version":null}`, `{"version":0}`, `{"version":-1}`, `{"version":"1"}`, `{"version":true}`, `{"version":1.0}`, `{"version":1e0}`, `{"version":9223372036854775808}`, `{"Version":1}`, `{"version":1,"version":1}`, `{"version":1,"title":"Changed"}`, `{"version":1} {}`,
		`{"version":1,"removeDepends":null}`, `{"version":1,"removeDepends":"true"}`, `{"version":1,"removeDepends":0}`, `{"version":1,"removeDepends":[]}`, `{"version":1,"removeDepends":{}}`, `{"version":1,"RemoveDepends":true}`, `{"version":1,"removeDepends":true,"removeDepends":false}`,
	} {
		assertProjectError(t, projectRequest(h, http.MethodDelete, path, body), http.StatusBadRequest, "invalid_input")
	}
	for _, query := range []string{"", "version=1", "unknown=secret"} {
		assertProjectError(t, projectRequest(h, http.MethodDelete, path+"?"+query, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	}
	for _, malformed := range []string{taskCollection("invalid") + "/" + testTaskID, taskCollection(testProjectID) + "/invalid"} {
		assertProjectError(t, projectRequest(h, http.MethodDelete, malformed, `{"version":1}`), http.StatusBadRequest, "invalid_input")
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatal("invalid deletion called service")
	}
	dependentID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	h.Tasks.DeleteFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.DeleteTask) error {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.RemoveDepends {
			t.Fatalf("strict delete input: %+v", input)
		}
		return &model.Fault{Code: "dependency_unsatisfied", Message: "Task is referenced.", TaskIDs: []string{dependentID}}
	}
	response := projectRequest(h, http.MethodDelete, path, `{"version":1}`)
	fault := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
	if fault.Error.Code != "dependency_unsatisfied" || fault.Error.Details == nil || !reflect.DeepEqual(fault.Error.Details.TaskIDs, []string{dependentID}) {
		t.Fatalf("dependency refusal lacks affected task: %s", response.Body)
	}
}

func TestTaskHTTPDeletionForwardsExplicitRelationshipRemoval(t *testing.T) {
	for _, tc := range []struct {
		body    string
		remove  bool
		failure error
		status  int
	}{
		{`{"version":1}`, false, &model.Fault{Code: "dependency_unsatisfied", Message: "Task is referenced."}, http.StatusConflict},
		{`{"version":1,"removeDepends":false}`, false, &model.Fault{Code: "dependency_unsatisfied", Message: "Task is referenced."}, http.StatusConflict},
		{`{"version":1,"removeDepends":true}`, true, nil, http.StatusNoContent},
		{`{"version":1,"removeDepends":false}`, false, nil, http.StatusNoContent},
	} {
		t.Run(tc.body+"/"+http.StatusText(tc.status), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.DeleteFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.DeleteTask) error {
				if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.RemoveDepends != tc.remove {
					t.Fatalf("delete relationship request changed: %+v", input)
				}
				return tc.failure
			}
			response := projectRequest(h, http.MethodDelete, taskCollection(testProjectID)+"/"+testTaskID, tc.body)
			if tc.status == http.StatusConflict {
				assertProjectError(t, response, tc.status, "dependency_unsatisfied")
			} else if response.Code != http.StatusNoContent || response.Body.Len() != 0 || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("deletion response: %d %s headers=%v", response.Code, response.Body, response.Header())
			}
		})
	}
}

func TestTaskHTTPDeletedTaskReadMapsGone(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.ObserveFunc = func(ctx context.Context, principal model.Principal, projectID, id string) (taskservice.TaskObservation, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID {
			t.Fatalf("deleted Task read scope: %+v %s %s", principal, projectID, id)
		}
		return taskservice.TaskObservation{}, &model.Fault{Code: "task_deleted", Message: "Task was deleted.", Cause: model.ErrTaskDeleted}
	}
	response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
	assertProjectError(t, response, http.StatusGone, "task_deleted")
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("deleted Task read cache policy: %v", response.Header())
	}
}
