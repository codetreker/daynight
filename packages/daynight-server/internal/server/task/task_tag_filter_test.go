package task_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const (
	filterTagA = "a1111111-a111-4111-8111-a11111111111"
	filterTagB = "b2222222-b222-4222-8222-b22222222222"
)

func TestTaskHTTPTagFiltersPreserveListReadyAndGoalScopes(t *testing.T) {
	for _, test := range []struct {
		name, query string
		want        store.TagFilter
	}{
		{"default all", "tagIds=" + filterTagA, store.TagFilter{TagIDs: []string{filterTagA}, TagMatch: "all"}},
		{"canonical set", "tagIds=" + filterTagB + "," + strings.ToUpper(filterTagA) + "," + filterTagA + "&tagMatch=any", store.TagFilter{TagIDs: []string{filterTagA, filterTagB}, TagMatch: "any"}},
		{"untagged", "untagged=true", store.TagFilter{TagIDs: []string{}, TagMatch: "all", Untagged: true}},
		{"no IDs", "tagMatch=any&untagged=false", store.TagFilter{TagIDs: []string{}, TagMatch: "any"}},
	} {
		for _, scope := range []string{"type=task&parentId=none&assignedTo=me", "status=todo&ready=true&limit=2", "type=goal"} {
			t.Run(test.name+"/"+scope, func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				h.Tasks.ListFunc = func(ctx context.Context, principal model.Principal, project string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
					if ctx.Err() != nil || principal != testPrincipal() || project != testProjectID || !reflect.DeepEqual(input.TagFilter, test.want) {
						t.Fatalf("tag query changed: %#v", input)
					}
					switch scope {
					case "type=task&parentId=none&assignedTo=me":
						if input.Type != model.TaskTypeTask || input.Parent == nil || *input.Parent != "none" || input.AssignedTo == nil || *input.AssignedTo != "me" {
							t.Fatalf("list scope lost: %#v", input)
						}
					case "status=todo&ready=true&limit=2":
						if input.Status == nil || *input.Status != model.TaskTodo || input.Ready == nil || !*input.Ready || input.Limit != 2 {
							t.Fatalf("ready scope lost: %#v", input)
						}
					case "type=goal":
						if input.Type != model.TaskTypeGoal {
							t.Fatalf("goal scope lost: %#v", input)
						}
					}
					return taskservice.TaskPage{Items: []model.Task{}}, nil
				}
				decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?"+scope+"&"+test.query, ""), http.StatusOK)
				if h.Tasks.Calls("List") != 1 {
					t.Fatal("tag list did not invoke business exactly once")
				}
			})
		}
	}
}

func TestTaskHTTPInvalidTagQueriesDoNotInvokeBusiness(t *testing.T) {
	for _, test := range []struct{ query, code string }{
		{"tagIds=invalid", "invalid_tag_filter"},
		{"tagIds=" + filterTagA + ",invalid", "invalid_tag_filter"},
		{"tagIds=" + filterTagA + ",", "invalid_tag_filter"},
		{"tagIds=," + filterTagA, "invalid_tag_filter"},
		{"tagIds=" + filterTagA + ",&untagged=true", "invalid_tag_filter"},
		{"tagIds=" + filterTagA + "&untagged=true", "invalid_tag_filter"},
		{"tagMatch=ALL", "invalid_tag_filter"},
		{"tagMatch=none", "invalid_tag_filter"},
		{"untagged=1", "invalid_tag_filter"},
		{"untagged=True", "invalid_tag_filter"},
		{"tagIds=", "invalid_input"},
		{"tagMatch=", "invalid_input"},
		{"untagged=", "invalid_input"},
		{"tagIds=" + filterTagA + "&tagIds=" + filterTagB, "invalid_input"},
		{"tagMatch=all&tagMatch=any", "invalid_input"},
		{"untagged=true&untagged=false", "invalid_input"},
		{"tagIds=%ZZ", "invalid_input"},
	} {
		t.Run(test.query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			for _, scope := range []string{"", "ready=true&", "include=session&"} {
				assertProjectError(t, projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?"+scope+test.query, ""), http.StatusBadRequest, test.code)
			}
			if h.Tasks.TotalCalls() != 0 || h.Observations.TotalCalls() != 0 {
				t.Fatal("invalid tag query reached business")
			}
		})
	}
}

func TestTaskHTTPTagFilterQualificationRefusal(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		return taskservice.TaskPage{}, &model.Fault{Code: "invalid_tag_filter", Message: "A selected tag is unavailable in this Project."}
	}
	response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?tagIds="+filterTagA, "")
	assertProjectError(t, response, http.StatusBadRequest, "invalid_tag_filter")
	if h.Tasks.Calls("List") != 1 || h.Observations.TotalCalls() != 0 {
		t.Fatal("qualification refusal retried or invoked another operation")
	}
}

func TestTaskHTTPTagFilterCancellationReachesObservedReady(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, finished := make(chan struct{}), make(chan struct{})
	h.Observations.ListFunc = func(ctx context.Context, p model.Principal, project string, input taskservice.TaskListRequest) (taskservice.ObservedTaskPage, error) {
		if p != testPrincipal() || project != testProjectID || input.Ready == nil || !*input.Ready || !reflect.DeepEqual(input.TagFilter, store.TagFilter{TagIDs: []string{filterTagA}, TagMatch: "all"}) {
			t.Error("observed ready lost tag filter or identity")
		}
		close(started)
		<-ctx.Done()
		return taskservice.ObservedTaskPage{}, ctx.Err()
	}
	request := httptest.NewRequest(http.MethodGet, taskCollection(testProjectID)+"?ready=true&include=session&tagIds="+filterTagA, nil).WithContext(ctx)
	authorizeResourceRequest(h, request)
	response := httptest.NewRecorder()
	go func() { defer close(finished); h.ServeHTTP(response, request) }()
	await(t, started)
	cancel()
	await(t, finished)
	if response.Body.Len() != 0 || h.Observations.Calls("ObserveList") != 1 || h.Tasks.TotalCalls() != 0 {
		t.Fatalf("cancelled tagged read published or repeated: %d %s", response.Code, response.Body.String())
	}
}

func TestTaskHTTPTagFilterTransportLimitsDoNotInvokeBusiness(t *testing.T) {
	for _, length := range []int{transport.MaxRawQueryBytes + 1, transport.MaxRequestTargetBytes + 1} {
		h := newHTTPFixture(t, io.Discard)
		response := projectRequest(h, http.MethodGet, taskCollection(testProjectID)+"?tagIds="+strings.Repeat("a", length), "")
		if response.Code != http.StatusRequestURITooLong || h.Tasks.TotalCalls() != 0 || h.Observations.TotalCalls() != 0 {
			t.Fatalf("oversized tag query reached business: %d %s", response.Code, response.Body.String())
		}
	}
}
