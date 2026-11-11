package task_test

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestGoalHTTPWriteFieldPresence(t *testing.T) {
	parentID := testTaskID
	for _, tc := range []struct {
		body               string
		assigned, platform bool
		parent             *string
	}{
		{`{"title":"x","type":"goal"}`, false, false, nil},
		{`{"title":"x","type":"goal","assignedTo":null,"requiredPlatform":null}`, true, true, nil},
		{`{"title":"x","type":"task","parentId":"` + testTaskID + `"}`, false, false, &parentID},
	} {
		t.Run(tc.body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.CreateFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
				if input.AssignedToPresent != tc.assigned || input.RequiredPlatformPresent != tc.platform || !model.EqualOptional(input.ParentID, tc.parent) {
					t.Fatalf("field presence: %+v", input)
				}
				return testTask("x"), nil
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID), tc.body)
			if response.Code != http.StatusCreated {
				t.Fatalf("create: %d %s", response.Code, response.Body)
			}
		})
	}
	for _, tc := range []struct {
		body   string
		parent *string
	}{
		{`{"version":3,"parentId":null}`, nil},
		{`{"version":3,"parentId":"` + testTaskID + `"}`, &parentID},
	} {
		t.Run(tc.body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.UpdateFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.UpdateTask) (model.Task, error) {
				if input.ParentID == nil || !model.EqualOptional(*input.ParentID, tc.parent) {
					t.Fatalf("parent patch: %+v", input)
				}
				return testTask("x"), nil
			}
			response := projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, tc.body)
			if response.Code != http.StatusOK {
				t.Fatalf("update: %d %s", response.Code, response.Body)
			}
		})
	}
}
