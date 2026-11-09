package task_test

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskListPlatformSpecificQuery(t *testing.T) {
	for _, query := range []string{"", "?platformSpecific=true", "?platformSpecific=false"} {
		t.Run(query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			called := false
			h.Tasks.ListFunc = func(_ context.Context, _ model.Principal, projectID string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
				called = true
				if projectID != testProjectID || (input.PlatformSpecific == nil) != (query == "") || input.PlatformSpecific != nil && *input.PlatformSpecific != (query == "?platformSpecific=true") {
					t.Fatalf("query not preserved: %#v", input)
				}
				return taskservice.TaskPage{Items: []model.Task{}}, nil
			}
			decodeResponse[api.TaskPage](t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID)+query, "", ""), http.StatusOK)
			if !called {
				t.Fatal("list was not called")
			}
		})
	}
	for _, query := range []string{"?platformSpecific=", "?platformSpecific=1", "?platformSpecific=False", "?platformSpecific=null", "?platformSpecific=true&platformSpecific=false"} {
		t.Run(query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, protocolRequest(h, http.MethodGet, taskCollection(testProjectID)+query, "", ""), http.StatusBadRequest, "invalid_input")
		})
	}
}
