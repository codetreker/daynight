package task_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestOrdinaryTaskCreateHTTPParentAndProjection(t *testing.T) {
	parentID := "f6666666-f666-4666-8666-f66666666666"
	for _, view := range []string{"default", "extended", "receipt"} {
		t.Run(view, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:dependencies", "task:read", "task:write"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := scopedTaskAuthentication{model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}}
			mux := http.NewServeMux()
			if err := taskhttp.RegisterScopedWriteRoutes(mux, f.Tasks, scopedGoalOperations{}, auth, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
				t.Fatal(err)
			}
			f.Tasks.CreateFunc = func(ctx context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
				if principal != f.principal || projectID != testProjectID || input.ParentTaskID == nil || *input.ParentTaskID != parentID || input.ParentID != nil || input.Title != "Child" {
					t.Fatalf("create input: %+v", input)
				}
				authorization, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
				if !present || authorization.Principal != principal || full != (view != "receipt") {
					t.Fatalf("write authorization=%+v full=%v present=%v", authorization, full, present)
				}
				result := testTask("Child")
				result.ParentID, result.ParentType = &parentID, model.TaskTypeTask
				return result, nil
			}
			request := httptest.NewRequest(http.MethodPost, taskCollection(testProjectID), strings.NewReader(`{"title":"Child","parentId":null,"parentTaskId":"`+strings.ToUpper(parentID)+`"}`))
			request.Header.Set("Content-Type", "application/json")
			if view != "default" {
				request.Header.Set("Daynight-Task-Relations", "task-parent-v1")
			}
			if view == "receipt" {
				request.Header.Set("Daynight-Return", "receipt-v1")
			}
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			var got map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || response.Code != http.StatusCreated {
				t.Fatalf("create response: %d %s %v", response.Code, response.Body, err)
			}
			if view == "receipt" {
				if len(got) != 3 || got["taskId"] != testTaskID || got["projectId"] != testProjectID || got["version"] != float64(1) {
					t.Fatalf("receipt=%v", got)
				}
			} else {
				parent, present := got["parentTaskId"]
				if got["parentId"] != nil || present != (view == "extended") || present && parent != parentID {
					t.Fatalf("relation projection=%v", got)
				}
			}
			if response.Header().Get("Location") != taskCollection(testProjectID)+"/"+testTaskID || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("mutation headers=%v", response.Header())
			}
		})
	}
}

func TestOrdinaryTaskCreateHTTPRejectsInvalidParentWithoutWrite(t *testing.T) {
	for _, body := range []string{
		`{"title":"Child","parentTaskId":null}`,
		`{"title":"Child","parentTaskId":false}`,
		`{"title":"Child","parentTaskId":"invalid"}`,
		`{"title":"Child","parentTaskId":"` + testTaskID + `","parentId":"` + testTaskID + `"}`,
	} {
		t.Run(body, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			response := projectRequest(f, http.MethodPost, taskCollection(testProjectID), body)
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if f.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid parent reached business operations")
			}
		})
	}
}

func TestOrdinaryTaskCreateLegacyHTTPWiresOrdinaryParent(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	parentID := "f6666666-f666-4666-8666-f66666666666"
	f.Tasks.CreateFunc = func(ctx context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
		if principal != f.principal || projectID != testProjectID || input.ParentTaskID == nil || *input.ParentTaskID != parentID {
			t.Fatalf("create input=%+v", input)
		}
		if _, _, scoped := taskservice.TaskWriteAuthorizationFromContext(ctx); scoped {
			t.Fatal("legacy route added scoped authorization")
		}
		result := testTask("Child")
		result.ParentID, result.ParentType = &parentID, model.TaskTypeTask
		return result, nil
	}
	response := projectRequest(f, http.MethodPost, taskCollection(testProjectID), `{"title":"Child","parentTaskId":"`+parentID+`"}`)
	got := decodeResponse[map[string]any](t, response, http.StatusCreated)
	if _, present := got["parentTaskId"]; present || got["parentId"] != nil {
		t.Fatalf("legacy create projection=%v", got)
	}
}

func TestOrdinaryTaskUpdateHTTPRejectsNewParentField(t *testing.T) {
	for _, value := range []string{`null`, `"` + testTaskID + `"`} {
		f := newHTTPFixture(t, io.Discard)
		response := projectRequest(f, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, `{"version":1,"title":"Changed","parentTaskId":`+value+`}`)
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if f.Tasks.TotalCalls() != 0 {
			t.Fatal("ordinary parent patch reached business operations")
		}
	}
}

func TestOrdinaryTaskStatusHTTPPreservesConfirmationPresence(t *testing.T) {
	for _, confirmation := range []string{"", `,"cancelDescendants":false`, `,"cancelDescendants":true`} {
		t.Run(confirmation, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			f.Tasks.SetStatusFunc = func(_ context.Context, principal model.Principal, projectID, taskID string, input taskcore.SetTaskStatus) (model.Task, error) {
				if principal != f.principal || projectID != testProjectID || taskID != testTaskID || input.Status != model.TaskCancelled || input.Version != 9223372036854775807 || input.CancelDescendantsPresent != (confirmation != "") || input.CancelDescendants != strings.Contains(confirmation, "true") {
					t.Fatalf("status input=%+v", input)
				}
				result := testTask("Parent")
				result.Status = model.TaskCancelled
				return result, nil
			}
			response := projectRequest(f, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", `{"version":9223372036854775807,"status":"cancelled"`+confirmation+`}`)
			if response.Code != http.StatusOK {
				t.Fatalf("status response=%d %s", response.Code, response.Body)
			}
		})
	}
}

func TestOrdinaryTaskStatusHTTPRejectsNonBooleanConfirmationWithoutWrite(t *testing.T) {
	for _, value := range []string{`null`, `"true"`, `1`, `[]`, `{}`} {
		t.Run(value, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			response := projectRequest(f, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", `{"version":1,"status":"cancelled","cancelDescendants":`+value+`}`)
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if f.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid confirmation reached business operations")
			}
		})
	}
}

func TestOrdinaryTaskStatusScopedHTTPConfirmationReceipt(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:status"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := scopedTaskAuthentication{model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}}
	mux := http.NewServeMux()
	if err := taskhttp.RegisterScopedWriteRoutes(mux, f.Tasks, scopedGoalOperations{}, auth, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	f.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, taskID string, input taskcore.SetTaskStatus) (model.Task, error) {
		authorization, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present || full || authorization.Principal != f.principal || principal != f.principal || projectID != testProjectID || taskID != testTaskID || !input.CancelDescendants || !input.CancelDescendantsPresent || input.Version != 1 || input.Status != model.TaskCancelled {
			t.Fatalf("scoped status authorization=%+v full=%v present=%v input=%+v", authorization, full, present, input)
		}
		result := testTask("Parent")
		result.Version = 2
		return result, nil
	}
	request := httptest.NewRequest(http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", strings.NewReader(`{"version":1,"status":"cancelled","cancelDescendants":true}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Daynight-Task-Relations", "task-parent-v1")
	request.Header.Set("Daynight-Return", "receipt-v1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	got := decodeResponse[map[string]any](t, response, http.StatusOK)
	if len(got) != 3 || got["projectId"] != testProjectID || got["taskId"] != testTaskID || got["version"] != float64(2) || response.Header().Get("Daynight-Return") != "receipt-v1" {
		t.Fatalf("confirmation receipt=%v headers=%v", got, response.Header())
	}
}

func TestOrdinaryTaskHTTPPreservesBusinessRefusalIDs(t *testing.T) {
	for _, code := range []string{"task_unfinished_children", "task_parent_terminal", "task_parent_immutable"} {
		t.Run(code, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			f.Tasks.SetStatusFunc = func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error) {
				return model.Task{}, &model.Fault{Code: code, Message: "Task relationship prevents this write.", TaskIDs: []string{testTaskID}}
			}
			response := projectRequest(f, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", `{"version":1,"status":"cancelled","cancelDescendants":true}`)
			assertProjectError(t, response, http.StatusConflict, code)
			var got struct {
				Error struct {
					Details struct {
						TaskIDs []string `json:"taskIds"`
					} `json:"details"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || len(got.Error.Details.TaskIDs) != 1 || got.Error.Details.TaskIDs[0] != testTaskID {
				t.Fatalf("refusal task IDs=%+v body=%s err=%v", got, response.Body, err)
			}
		})
	}
}
