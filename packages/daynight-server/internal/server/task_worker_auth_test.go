package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type workerHTTPCredential struct {
	principal model.Principal
	value     string
}

func TestWorkerHTTPAuthenticatedOwnerAndWithdrawal(t *testing.T) {
	tasks := &taskHTTPOperations{t: t}
	identity := &operationHTTPIdentity{t: t, CallbackURLFn: func() string { return configuredTestConfig().UniAuthCallbackURL }}
	var logs bytes.Buffer
	handler := newOperationHTTPServerWithIdentity(t, identity, func(deps *httpDependencies) { deps.Tasks = tasks }, &logs, defaultHTTPPrincipal())
	origin := configuredTestConfig().PublicOrigin
	admin := workerHTTPCredential{principal: model.Principal{UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	member := workerHTTPCredential{principal: model.Principal{UserID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", CredentialID: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	outsider := workerHTTPCredential{principal: model.Principal{UserID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CredentialID: "cccccccc-1111-4111-8111-cccccccccccc", Kind: model.SessionCredential}, value: secret.Random("dnst_")}
	bearer := workerHTTPCredential{principal: model.Principal{UserID: member.principal.UserID, CredentialID: "dddddddd-1111-4111-8111-dddddddddddd", Kind: model.PATCredential}, value: secret.Random("dnpat_")}
	request := func(actor *workerHTTPCredential, plan *workerHTTPOperationPlan, method, path string, body any, requestOrigin string, status int, code string) *httptest.ResponseRecorder {
		t.Helper()
		authentications := 0
		marker := new(int)
		identity.AuthenticateFn = func(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
			requireOperationHTTPContext(t, ctx)
			authentications++
			if actor == nil || authentications != 1 || kind != actor.principal.Kind || value != actor.value || ctx.Err() != nil || httpx.RequestID(ctx) != "worker-owner-test" || ctx.Value(workerHTTPContextKey{}) != marker {
				t.Fatal("Worker authentication changed credential, kind or request context")
			}
			return actor.principal, nil
		}
		if plan != nil {
			plan.requestID, plan.marker = "worker-owner-test", marker
		}
		req := httptest.NewRequest(method, origin+path, strings.NewReader(jsonBody(t, body)))
		req = req.WithContext(context.WithValue(req.Context(), workerHTTPContextKey{}, marker))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Request-ID", "worker-owner-test")
		if requestOrigin != "" {
			req.Header.Set("Origin", requestOrigin)
		}
		if actor != nil {
			if actor.principal.Kind == model.PATCredential {
				req.Header.Set("Authorization", "Bearer "+actor.value)
			} else {
				req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: actor.value})
			}
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("worker response status/cache=%d/%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body)
		}
		if code != "" && decodeResponse[api.ErrorResponse](t, response, status).Error.Code != code {
			t.Fatalf("unexpected worker refusal code: %s", response.Body)
		}
		if code == "" && response.Header().Get("Daynight-User-ID") != actor.principal.UserID {
			t.Fatal("worker response lost its authenticated identity")
		}
		wantAuth := 0
		if actor != nil {
			wantAuth = 1
		}
		if authentications != wantAuth {
			t.Fatalf("worker authentication calls=%d want=%d", authentications, wantAuth)
		}
		if plan != nil {
			plan.check()
		}
		tasks.ClaimWorkerCall, tasks.UpdateWorkerCall, tasks.ReleaseWorkerCall, tasks.WithdrawWorkerCall, tasks.ResumeWorkerCall, tasks.UpdateCall = nil, nil, nil, nil, nil, nil
		identity.AuthenticateFn = nil
		return response
	}
	current := workerHTTPTask(t)
	current.Title, current.AssignedTo = "Owned execution", &member.principal.UserID
	platform := model.TaskPlatform("linux")
	current.RequiredPlatform = &platform
	taskPath := "/api/v1/projects/" + current.ProjectID + "/tasks/" + current.ID
	path := taskPath + "/worker-claim"
	expectAction := func(actor model.Principal, method, actionPath string, body any, result model.Task, failure error) *workerHTTPOperationPlan {
		t.Helper()
		values := body.(map[string]any)
		version, claimID := values["version"].(int64), values["claimId"]
		switch {
		case method == http.MethodPatch:
			phase := model.WorkerPhase(values["phase"].(string))
			return expectWorkerHTTPUpdate(t, tasks, current, actor, taskcore.UpdateWorker{Version: version, ClaimID: claimID.(string), Phase: &phase}, result, failure)
		case strings.HasSuffix(actionPath, "/release"):
			return expectWorkerHTTPRelease(t, tasks, current, actor, taskcore.ReleaseWorker{Version: version, ClaimID: claimID.(string), StoppedConfirmed: values["stoppedConfirmed"].(bool)}, result, failure)
		case strings.HasSuffix(actionPath, "/withdraw"):
			return expectWorkerHTTPWithdraw(t, tasks, current, actor, taskcore.WithdrawWorker{Version: version, ClaimID: claimID.(string)}, result, failure)
		case strings.HasSuffix(actionPath, "/resume"):
			return expectWorkerHTTPResume(t, tasks, current, actor, taskcore.ResumeWorker{ClaimWorker: workerHTTPClaimInput(values), PreviousClaimID: values["previousClaimId"].(string)}, result, failure)
		default:
			return expectWorkerHTTPClaim(t, tasks, current, actor, workerHTTPClaimInput(values), result, failure)
		}
	}
	refusal := func(actor workerHTTPCredential, method, path string, body any, status int, code string) {
		t.Helper()
		var failure error
		switch code {
		case "not_found":
			failure = &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound}
		case "claim_conflict":
			failure = &model.Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."}
		case "forbidden":
			message := "Project administrator access is required."
			if method == http.MethodPatch {
				message = "Only the current execution owner may update worker execution."
			}
			failure = &model.Fault{Code: "forbidden", Message: message}
		default:
			t.Fatalf("unconfigured Worker refusal %s", code)
		}
		plan := expectAction(actor.principal, method, path, body, model.Task{}, failure)
		request(&actor, plan, method, path, body, origin, status, code)
	}
	assertAuthenticationRefusals := func(method, actionPath string, body any) {
		t.Helper()
		request(nil, nil, method, actionPath, body, "", http.StatusUnauthorized, "unauthenticated")
		refusal(outsider, method, actionPath, body, http.StatusNotFound, "not_found")
		request(&member, nil, method, actionPath, body, "https://foreign.example", http.StatusForbidden, "forbidden")
	}
	claimedAt := current.UpdatedAt.Add(time.Minute)
	claimResult := func(before model.Task, body map[string]any, owner string) (model.Task, model.WorkerClaim) {
		t.Helper()
		machine := body["machine"].(map[string]any)
		claim := model.WorkerClaim{ClaimID: body["claimId"].(string), State: model.WorkerActive, UserID: owner, WorkerID: body["workerId"].(string), Machine: model.WorkerMachine{ID: machine["id"].(string), Name: machine["name"].(string)}, Platform: "linux", Agent: "codex", AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string), Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
		after := before
		after.Status, after.Ready, after.Version = model.TaskInProgress, false, before.Version+1
		startedAt := claimedAt
		after.UpdatedAt, after.StartedAt = claimedAt, &startedAt
		after.Properties = workerHTTPProperties(t, before.Properties, &claim)
		return after, claim
	}
	apply := func(actor workerHTTPCredential, method, actionPath string, body any, after model.Task) api.Task {
		t.Helper()
		plan := expectAction(actor.principal, method, actionPath, body, after, nil)
		requestOrigin := origin
		if actor.principal.Kind == model.PATCredential {
			requestOrigin = ""
		}
		response := request(&actor, plan, method, actionPath, body, requestOrigin, http.StatusOK, "")
		task := decodeResponse[api.Task](t, response, http.StatusOK)
		assertWorkerHTTPTask(t, task, after)
		if task.Version != after.Version || task.Status != string(after.Status) || task.AssignedTo == nil || *task.AssignedTo != member.principal.UserID {
			t.Fatalf("worker resource did not reflect the supplied authoritative row: %#v", task)
		}
		return task
	}
	body := workerClaimBody(current.Version)
	assertAuthenticationRefusals(http.MethodPost, path, body)
	after, firstClaim := claimResult(current, body, member.principal.UserID)
	task := apply(bearer, http.MethodPost, path, body, after)
	current = after
	if claim := apiWorker(t, task.Properties); claim == nil || claim.UserID != member.principal.UserID || claim.UserID == admin.principal.UserID {
		t.Fatal("PAT claim did not derive its execution owner from authentication")
	}
	for _, action := range []struct {
		method, path string
		body         map[string]any
	}{
		{http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}},
		{http.MethodPost, path + "/release", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "stoppedConfirmed": true}},
		{http.MethodPost, path + "/withdraw", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID}},
	} {
		assertAuthenticationRefusals(action.method, action.path, action.body)
	}
	refusal(admin, http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}, http.StatusForbidden, "forbidden")
	withdrawn := current
	withdrawn.Status, withdrawn.AllowAgents, withdrawn.Ready = model.TaskTodo, false, true
	withdrawn.StartedAt, withdrawn.CompletedAt = nil, nil
	withdrawn.Version, withdrawn.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	withdrawn.Properties = workerHTTPProperties(t, current.Properties, nil)
	task = apply(bearer, http.MethodPost, path+"/withdraw", map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID}, withdrawn)
	current = withdrawn
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("owner withdrawal did not reset execution and disable automatic claims")
	}
	refusal(member, http.MethodPatch, path, map[string]any{"version": current.Version, "claimId": firstClaim.ClaimID, "phase": "executing"}, http.StatusConflict, "claim_conflict")
	enabled := current
	enabled.AllowAgents, enabled.Version, enabled.UpdatedAt = true, current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	enabledPlan := newWorkerHTTPOperationPlan(t, member.principal, current)
	enabledResult := copyTaskHTTPTask(enabled)
	enabledVersion := current.Version
	tasks.UpdateCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.UpdateTask) (model.Task, error) {
		enabledPlan.require(ctx, principal, projectID, taskID)
		allowed := true
		expected := taskcore.UpdateTask{Version: enabledVersion, AllowAgents: &allowed}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("permission update=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(enabledResult), nil
	}
	response := request(&member, enabledPlan, http.MethodPatch, taskPath, map[string]any{"version": current.Version, "allowAgents": true}, origin, http.StatusOK, "")
	assertWorkerHTTPTask(t, decodeResponse[api.Task](t, response, http.StatusOK), enabledResult)
	current = enabled
	claimedAt = current.UpdatedAt.Add(time.Minute)
	body = workerClaimBody(current.Version)
	after, secondClaim := claimResult(current, body, member.principal.UserID)
	apply(member, http.MethodPost, path, body, after)
	current = after
	released := secondClaim
	released.State = model.WorkerReleased
	after = current
	after.Status, after.Ready, after.StartedAt = model.TaskTodo, true, nil
	after.Version, after.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	after.Properties = workerHTTPProperties(t, current.Properties, &released)
	apply(admin, http.MethodPost, path+"/release", map[string]any{"version": current.Version, "claimId": secondClaim.ClaimID, "stoppedConfirmed": true}, after)
	current = after
	claimedAt = current.UpdatedAt.Add(time.Minute)
	resume := workerClaimBody(current.Version)
	resume["previousClaimId"] = released.ClaimID
	refusal(outsider, http.MethodPost, path+"/resume", resume, http.StatusNotFound, "not_found")
	request(nil, nil, http.MethodPost, path+"/resume", resume, "", http.StatusUnauthorized, "unauthenticated")
	after, resumedClaim := claimResult(current, resume, admin.principal.UserID)
	task = apply(admin, http.MethodPost, path+"/resume", resume, after)
	current = after
	if claim := apiWorker(t, task.Properties); claim == nil || claim.UserID != admin.principal.UserID || claim.ClaimID != resume["claimId"] {
		t.Fatal("manual resume did not establish the authorized caller's new claim")
	}
	withdraw := map[string]any{"version": current.Version, "claimId": resumedClaim.ClaimID}
	refusal(member, http.MethodPost, path+"/withdraw", withdraw, http.StatusForbidden, "forbidden")
	after = current
	after.Status, after.AllowAgents, after.Ready, after.StartedAt, after.CompletedAt = model.TaskTodo, false, true, nil, nil
	after.Version, after.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Microsecond)
	after.Properties = workerHTTPProperties(t, current.Properties, nil)
	task = apply(admin, http.MethodPost, path+"/withdraw", withdraw, after)
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" {
		t.Fatal("administrator withdrawal retained ownership")
	}
	for _, value := range []string{bearer.value, member.value, admin.value, outsider.value, "Owned execution", "Worker machine"} {
		if strings.Contains(logs.String(), value) {
			t.Fatal("worker authentication or execution content leaked to logs")
		}
	}
	if !reflect.DeepEqual(current.AssignedTo, after.AssignedTo) {
		t.Fatal("worker withdrawal changed the assignee")
	}
}
