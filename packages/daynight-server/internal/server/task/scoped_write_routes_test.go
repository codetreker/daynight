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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type scopedTaskAuthentication struct{ authorization model.CredentialAuthorization }

func (a scopedTaskAuthentication) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.authorization) }
}

func TestScopedTaskWriteReceiptDoesNotExposePriorContent(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := scopedTaskAuthentication{model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}}
	mux := http.NewServeMux()
	if err := taskhttp.RegisterScopedWriteRoutes(mux, f.Tasks, scopedGoalOperations{}, auth, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	f.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.UpdateTask) (model.Task, error) {
		actual, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present || full || actual.Principal != f.principal || actual.Policy == nil {
			t.Fatalf("authorization not forwarded for receipt: %+v %v %v", actual, full, present)
		}
		if p != f.principal || project != testProjectID || id != testTaskID || input.Title == nil || *input.Title != "Changed" || input.Version != 1 {
			t.Fatalf("wrong input: %+v", input)
		}
		result := testTask("Changed")
		result.Version = 2
		return result, nil
	}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/"+testProjectID+"/tasks/"+testTaskID, strings.NewReader(`{"version":1,"title":"Changed"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Daynight-Return", "receipt-v1")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || w.Header().Get("Daynight-Return") != "receipt-v1" || len(got) != 3 || got["projectId"] != testProjectID || got["taskId"] != testTaskID || got["version"] != float64(2) {
		t.Fatalf("receipt status=%d headers=%v body=%s error=%v", w.Code, w.Header(), w.Body, err)
	}
}

type scopedGoalOperations struct{}

func (scopedGoalOperations) ShowGoalDependencies(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error) {
	panic("unexpected read")
}
func (scopedGoalOperations) EditGoalDependencies(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
	panic("unexpected edit")
}

func TestScopedTaskFullResponseRequiresReadBeforeWrite(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}
	mux := http.NewServeMux()
	if err := taskhttp.RegisterScopedWriteRoutes(mux, f.Tasks, scopedGoalOperations{}, scopedTaskAuthentication{a}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	f.Tasks.UpdateFunc = func(ctx context.Context, _ model.Principal, _, _ string, _ taskcore.UpdateTask) (model.Task, error) {
		got, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present || !full {
			t.Fatal("full response admission not selected")
		}
		return model.Task{}, scopeadmission.Require(got, scopepolicy.TaskWrite, scopepolicy.TaskRead)
	}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/"+testProjectID+"/tasks/"+testTaskID, strings.NewReader(`{"version":1,"title":"Changed"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || w.Header().Get("Daynight-Return") != "" || !strings.Contains(w.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("full response refusal: status=%d headers=%v body=%s", w.Code, w.Header(), w.Body)
	}
}

func TestScopedMutationMethodFallbacks(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := scopedTaskAuthentication{model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}}
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := taskhttp.RegisterScopedWriteRoutes(mux, f.Tasks, scopedGoalOperations{}, auth, logger); err != nil {
		t.Fatal(err)
	}
	if err := taskhttp.RegisterScopedWorkerClaimRoutes(mux, f.Tasks, auth, logger); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ suffix, allow string }{
		{"/status", "PUT"}, {"/properties/name", "PUT, DELETE"},
		{"/worker-claim", "POST, PATCH"}, {"/worker-claim/release", "POST"}, {"/worker-claim/withdraw", "POST"},
	} {
		t.Run(tc.suffix, func(t *testing.T) {
			r := httptest.NewRequest("TRACE", "/api/v1/projects/"+testProjectID+"/tasks/"+testTaskID+tc.suffix, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != tc.allow || !strings.Contains(w.Body.String(), `"method_not_allowed"`) {
				t.Fatalf("fallback: %d Allow=%q %s", w.Code, w.Header().Get("Allow"), w.Body)
			}
		})
	}
}
