package task_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestScopedWorkerClaimRoutesForwardAuthorizationAndReceipt(t *testing.T) {
	for _, tc := range []struct {
		name, method, suffix string
		body                 map[string]any
		operation            scopepolicy.Operation
	}{
		{"claim", http.MethodPost, "", workerClaimBody(1), scopepolicy.WorkerClaim},
		{"update", http.MethodPatch, "", map[string]any{"version": 1, "claimId": workerHTTPClaimID, "phase": "executing"}, scopepolicy.WorkerReport},
		{"release", http.MethodPost, "/release", map[string]any{"version": 1, "claimId": workerHTTPClaimID, "stoppedConfirmed": true}, scopepolicy.WorkerRelease},
		{"withdraw", http.MethodPost, "/withdraw", map[string]any{"version": 1, "claimId": workerHTTPClaimID}, scopepolicy.WorkerRelease},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"worker:claim", "worker:release", "worker:report"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			a := model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}
			mux := http.NewServeMux()
			if err := taskhttp.RegisterScopedWorkerClaimRoutes(mux, f.Tasks, scopedTaskAuthentication{a}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
				t.Fatal(err)
			}
			calls := 0
			apply := func(ctx context.Context, p model.Principal, project, id string) (model.Task, error) {
				calls++
				got, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
				if !present || full || !reflect.DeepEqual(got, a) || p != f.principal || project != testProjectID || id != testTaskID {
					t.Fatalf("authorization or identity lost: %+v %v %v", got, full, present)
				}
				// The legacy protocol fence must survive authorization wrapping.
				if taskcore.RequireCompatibleWorker(ctx, &model.WorkerClaim{Agent: model.AgentClaude, AgentControlMode: model.AgentControlModeWeb}) == nil {
					t.Fatal("legacy worker protocol was not propagated")
				}
				if err := scopeadmission.Require(got, tc.operation); err != nil {
					t.Fatal(err)
				}
				result := testTask("private content")
				result.Version = 2
				return result, nil
			}
			f.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.ClaimWorker) (model.Task, error) {
				if tc.name != "claim" || !reflect.DeepEqual(input, taskcore.ClaimWorker{Version: 1, WorkerDescriptor: workerHTTPDescriptor(tc.body)}) {
					t.Fatalf("claim input: %+v", input)
				}
				return apply(ctx, p, project, id)
			}
			f.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.UpdateWorker) (model.Task, error) {
				if tc.name != "update" || input.Version != 1 || input.ClaimID != workerHTTPClaimID || input.Phase == nil || *input.Phase != model.WorkerExecuting {
					t.Fatalf("update input: %+v", input)
				}
				return apply(ctx, p, project, id)
			}
			f.Tasks.ReleaseWorkerFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.ReleaseWorker) (model.Task, error) {
				if tc.name != "release" || input.Version != 1 || input.ClaimID != workerHTTPClaimID || !input.StoppedConfirmed {
					t.Fatalf("release input: %+v", input)
				}
				return apply(ctx, p, project, id)
			}
			f.Tasks.WithdrawWorkerFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.WithdrawWorker) (model.Task, error) {
				if tc.name != "withdraw" || input.Version != 1 || input.ClaimID != workerHTTPClaimID {
					t.Fatalf("withdraw input: %+v", input)
				}
				return apply(ctx, p, project, id)
			}
			if tc.name != "claim" {
				f.Tasks.ClaimWorkerFunc = nil
			}
			if tc.name != "update" {
				f.Tasks.UpdateWorkerFunc = nil
			}
			if tc.name != "release" {
				f.Tasks.ReleaseWorkerFunc = nil
			}
			if tc.name != "withdraw" {
				f.Tasks.WithdrawWorkerFunc = nil
			}
			r := httptest.NewRequest(tc.method, workerHTTPPath()+tc.suffix, strings.NewReader(jsonBody(t, tc.body)))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Daynight-Return", "receipt-v1")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			var got map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || calls != 1 || w.Header().Get("Daynight-Return") != "receipt-v1" || len(got) != 3 || got["projectId"] != testProjectID || got["taskId"] != testTaskID || got["version"] != float64(2) {
				t.Fatalf("receipt status=%d calls=%d headers=%v body=%s err=%v", w.Code, calls, w.Header(), w.Body, err)
			}
		})
	}
}

func TestScopedWorkerClaimFullResponseRefusalAndProtocolParsing(t *testing.T) {
	f := newHTTPFixture(t, io.Discard)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"worker:claim"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}
	mux := http.NewServeMux()
	if err := taskhttp.RegisterScopedWorkerClaimRoutes(mux, f.Tasks, scopedTaskAuthentication{a}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	calls := 0
	f.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.ClaimWorker) (model.Task, error) {
		calls++
		got, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present || !full || got.Principal != p {
			t.Fatal("full response authorization not selected")
		}
		return model.Task{}, scopeadmission.Require(got, scopepolicy.WorkerClaim, scopepolicy.TaskRead)
	}
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, workerHTTPPath(), strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := request(jsonBody(t, workerClaimBody(1)))
	if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || calls != 1 || !strings.Contains(w.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("full response refusal: status=%d calls=%d headers=%v body=%s", w.Code, calls, w.Header(), w.Body)
	}
	w = request(`{"version":1,"claimId":null}`)
	if w.Code != http.StatusBadRequest || calls != 1 {
		t.Fatalf("malformed request reached service: status=%d calls=%d", w.Code, calls)
	}
}
