package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type startupTaskFixture struct {
	store        *httpTestStore
	handler      *resourceTestHandler
	task         api.Task
	snapshot     sp.Snapshot
	registration sp.Registration
}

func startupTaskSetup(t *testing.T) *startupTaskFixture {
	t.Helper()
	f := &startupTaskFixture{store: newHTTPTestStore(t)}
	principal := defaultHTTPPrincipal()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	worker := api.WorkerClaim{ClaimID: uuid.NewString(), State: "active", UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: api.WorkerMachine{ID: uuid.NewString(), Name: "Session test"}, Platform: "linux", Agent: "codex", AgentControlMode: "web", WorktreeID: uuid.NewString(), Phase: "executing", ClaimedAt: now}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Description: "", Status: "in_progress", AllowAgents: true, CreatedAt: now, UpdatedAt: now, Version: 1, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Properties: map[string]json.RawMessage{}, AssignedTo: &principal.UserID}
	f.task.Properties["worker"] = rawProperty(t, worker)
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "1"}}}
	f.registration = sp.Registration{ControllerInstanceID: uuid.NewString()}
	f.handler = taskComponentHandler(t, f.store, io.Discard, principal)
	startupTaskAuthentication(t, f.handler)
	extendedWorkerTestHandler(f.handler)
	return f
}

func startupTaskAuthentication(t *testing.T, handler *resourceTestHandler) {
	t.Helper()
	authentication := &taskHTTPIdentityWriter{t: t}
	var transactionContext context.Context
	calls := 0
	authentication.WriteIdentityCall = func(ctx context.Context, run func() error) (store.Completion, error) {
		if ctx.Err() != nil || run == nil || transactionContext != nil {
			t.Fatal("startup authentication lost request context")
		}
		transactionContext, calls = ctx, 0
		err := run()
		if calls != 1 {
			t.Errorf("startup authentication calls=%d, want1", calls)
		}
		transactionContext = nil
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	authentication.AuthenticateCall = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
		calls++
		if ctx != transactionContext || calls != 1 || ctx.Err() != nil || kind != handler.principal.Kind || !bytes.Equal(hash, secret.Hash(handler.token)) || now.IsZero() || now.Location() != time.UTC {
			t.Fatal("startup authentication changed credential identity")
		}
		return handler.principal, nil
	}
	handler.AuthenticateFunc = identityservice.New(authentication, nil, "https://daynight.example/api/v1/auth/callback").Authenticate
}

func startupTaskModel(value api.Task) model.Task {
	var platform *model.TaskPlatform
	if value.RequiredPlatform != nil {
		v := model.TaskPlatform(*value.RequiredPlatform)
		platform = &v
	}
	var tags []model.TagReference
	for _, tag := range value.Tags {
		tags = append(tags, model.TagReference{ID: tag.ID, Name: tag.Name})
	}
	return model.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description,
		Properties: taskproperty.Clone(value.Properties), Tags: tags, Status: model.TaskStatus(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt,
		CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn,
		BlockedBy: value.BlockedBy, RequiredPlatform: platform, AssignedTo: value.AssignedTo, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func startupReportValue(t *testing.T, body map[string]any) sp.StartupReport {
	t.Helper()
	value, err := sp.DecodeStartupReport([]byte(jsonBody(t, body)))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func startupReportedTask(t *testing.T, current model.Task, report sp.StartupReport) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	result.Properties["sessionStartup"] = rawProperty(t, report)
	result.Version, result.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	return result
}

func startupReplaceWorker(t *testing.T, current model.Task, change func(*api.WorkerClaim)) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	worker := apiWorker(t, result.Properties)
	change(worker)
	result.Properties["worker"] = rawProperty(t, worker)
	return result
}

// Each request installs a complete plan. A captured write cannot populate the
// facts supplied to a later Task or Session read.
func startupExpectWrite(t *testing.T, f *startupTaskFixture, current model.Task, report *sp.StartupReport, matched bool, returned *model.Task, observed *time.Time, principal model.Principal, beforeMatch func()) {
	t.Helper()
	base := newTaskHTTPMockBase(t, "startup")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	tasks := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }}
	counts := map[string]int{}
	var requestContext context.Context
	check := func(ctx context.Context, name string, valid bool) {
		counts[name]++
		if ctx != requestContext || counts[name] != 1 || !valid {
			t.Errorf("startup %s changed context, arguments or count", name)
			panic("invalid startup DAO call")
		}
	}
	project.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
		check(ctx, "access", reflect.DeepEqual(actual, principal))
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		check(ctx, "task", id == current.ID && counts["access"] == 1)
		return current, nil
	}
	if report != nil {
		sessions.MatchSessionStartupFn = func(ctx context.Context, id string, worker *model.WorkerClaim, actual sp.StartupReport) (bool, error) {
			expectedWorker, err := taskproperty.Worker(current.Properties)
			check(ctx, "match", err == nil && id == current.ID && reflect.DeepEqual(worker, expectedWorker) && reflect.DeepEqual(actual, *report) && counts["task"] == 1)
			if beforeMatch != nil {
				beforeMatch()
			}
			return matched, nil
		}
	}
	if observed != nil {
		tasks.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			check(ctx, "observed", counts["task"] == 1)
			return *observed, nil
		}
	}
	if returned != nil {
		wanted := taskcore.CurrentWrite(*returned)
		tasks.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
			check(ctx, "update", id == current.ID && reflect.DeepEqual(values, wanted) && counts["task"] == 1)
			return *returned, nil
		}
		var active *string
		worker, err := taskproperty.Worker(returned.Properties)
		if err != nil {
			t.Fatal(err)
		}
		if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
			active = &worker.ClaimID
		}
		wantDrain := store.TaskSessionDrain{ActiveClaim: active, SourceLifecycle: "active", GraceSeconds: 60,
			TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
			SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, value store.TaskSessionDrain) error {
			check(ctx, "drain", id == current.ID && counts["update"] == 1 && reflect.DeepEqual(value, wantDrain))
			return nil
		}
		wantTransition := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, value store.TaskSessionReceiptTransition) error {
			check(ctx, "receipts", id == current.ID && counts["drain"] == 1 && reflect.DeepEqual(value, wantTransition))
			return nil
		}
		if returned.Status != current.Status {
			capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
			capture.FreezeAudienceFn = func(ctx context.Context, project string, kinds []string) ([]store.WebhookAudience, error) {
				check(ctx, "capture", project == current.ProjectID && counts["receipts"] == 1 && reflect.DeepEqual(kinds, []string{protocol.StatusChanged}))
				return []store.WebhookAudience{}, nil
			}
			scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return capture }
		}
	}
	calls := 0
	f.store.WriteProjectCall = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		calls++
		if calls != 1 || id != current.ProjectID || work == nil {
			unexpectedHTTPCall(t, "startup WriteProject")
		}
		requestContext = ctx
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		if calls != 1 || counts["access"] != 1 || counts["task"] != 1 {
			t.Errorf("startup scope not consumed: calls=%d counts=%v", calls, counts)
		}
		if report != nil && counts["match"] != 1 {
			t.Errorf("startup matcher calls=%d, want1", counts["match"])
		}
		if returned != nil && (counts["update"] != 1 || counts["drain"] != 1 || counts["receipts"] != 1) {
			t.Errorf("startup write incomplete: %v", counts)
		}
		if observed != nil && counts["observed"] != 1 {
			t.Errorf("startup claim time calls=%d, want1", counts["observed"])
		}
		if returned != nil && returned.Status != current.Status && counts["capture"] != 1 {
			t.Errorf("startup status capture calls=%d, want1", counts["capture"])
		}
	})
}

func startupTaskDocument(t *testing.T, value model.Task) api.Task {
	t.Helper()
	var platform *string
	if value.RequiredPlatform != nil {
		v := string(*value.RequiredPlatform)
		platform = &v
	}
	return api.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description, Properties: taskproperty.Clone(value.Properties), Tags: tagHTTPReferences(value.Tags), Status: string(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt, CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn, BlockedBy: value.BlockedBy, AssignedTo: value.AssignedTo, RequiredPlatform: platform, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func startupBody(f *startupTaskFixture) map[string]any {
	return map[string]any{
		"schemaVersion": 1, "source": "worker", "sessionId": f.snapshot.SessionID, "claimId": f.snapshot.ClaimID,
		"executionGeneration": f.snapshot.ExecutionGeneration, "controllerInstanceId": f.registration.ControllerInstanceID,
		"revision": "1", "observedAt": "2026-11-05T00:00:00Z",
		"startup":  map[string]any{"state": "unknown", "reasonCode": "native_timeout"},
		"recovery": map[string]any{"state": "blocked", "reasonCode": "native_identity_missing"},
	}
}

func startupRequest(f *startupTaskFixture, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("X-Daynight-Startup-Version", "1")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func sendStartup(t *testing.T, f *startupTaskFixture, report map[string]any) api.Task {
	t.Helper()
	current := startupTaskModel(f.task)
	value := startupReportValue(t, report)
	previous, err := taskproperty.SessionStartup(current.Properties)
	if err != nil {
		t.Fatal(err)
	}
	expected := current
	var returned *model.Task
	if !reflect.DeepEqual(previous, &value) {
		expected = startupReportedTask(t, current, value)
		returned = &expected
	}
	startupExpectWrite(t, f, current, &value, true, returned, nil, f.handler.principal, nil)
	f.task = decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": current.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusOK)
	if !reflect.DeepEqual(f.task, startupTaskDocument(t, expected)) {
		t.Fatal("startup response changed expected Task fields")
	}
	return f.task
}

func TestStartupReportOrderingIdentityAndMissingEvidence(t *testing.T) {
	f := startupTaskSetup(t)
	report := startupBody(f)
	sendStartup(t, f, report)
	version := f.task.Version
	sendStartup(t, f, report)
	if f.task.Version != version {
		t.Fatal("identical report changed task version")
	}
	report["revision"] = "2"
	report["startup"] = map[string]any{"state": "ready", "reasonCode": "ready"}
	report["recovery"] = map[string]any{"state": "none", "reasonCode": nil}
	sendStartup(t, f, report)
	for _, field := range []string{"revision", "claimId", "sessionId", "executionGeneration", "controllerInstanceId"} {
		bad := startupBody(f)
		if field == "revision" {
			bad[field] = "1"
		} else if field == "executionGeneration" {
			bad[field] = "2"
		} else {
			bad[field] = uuid.NewString()
		}
		badValue := startupReportValue(t, bad)
		var matchedReport *sp.StartupReport = &badValue
		if field == "claimId" {
			matchedReport = nil
		}
		startupExpectWrite(t, f, startupTaskModel(f.task), matchedReport, field == "revision", nil, nil, f.handler.principal, nil)
		response := startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": bad}))
		assertProjectError(t, response, http.StatusConflict, "claim_conflict")
	}
	bad := startupBody(f)
	bad["revision"] = "2"
	badValue := startupReportValue(t, bad)
	startupExpectWrite(t, f, startupTaskModel(f.task), &badValue, true, nil, nil, f.handler.principal, nil)
	assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": bad})), http.StatusConflict, "claim_conflict")
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(f.task), jsonBody(t, map[string]any{"version": f.task.Version, "properties": map[string]any{"sessionStartup": report}})), http.StatusBadRequest, "invalid_input")
}

func TestStartupReportCannotWriteAfterCredentialRevocationOrCompletion(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoked", true: "completed"}[terminal], func(t *testing.T) {
			f := startupTaskSetup(t)
			report := startupBody(f)
			if terminal {
				current := startupTaskModel(f.task)
				current.Status = model.TaskDone
				current = startupReplaceWorker(t, current, func(w *api.WorkerClaim) { w.State = "completed" })
				startupExpectWrite(t, f, current, nil, false, nil, nil, f.handler.principal, nil)
			} else {
				authentication := &taskHTTPIdentityWriter{t: t}
				calls := 0
				var transactionContext context.Context
				authentication.WriteIdentityCall = func(ctx context.Context, run func() error) (store.Completion, error) {
					if ctx.Err() != nil || run == nil || transactionContext != nil {
						t.Fatal("revoked authentication lost request context")
					}
					transactionContext = ctx
					err := run()
					if calls != 1 {
						t.Errorf("revoked credential calls=%d, want1", calls)
					}
					transactionContext = nil
					if err != nil {
						return store.Completion{Outcome: store.TransactionNotCommitted}, err
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				}
				authentication.AuthenticateCall = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
					calls++
					if calls != 1 || ctx != transactionContext || kind != f.handler.principal.Kind || !bytes.Equal(hash, secret.Hash(f.handler.token)) || now.IsZero() || now.Location() != time.UTC || ctx.Err() != nil {
						t.Fatal("revoked credential changed identity")
					}
					return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "Credential has been revoked."}
				}
				f.handler.AuthenticateFunc = identityservice.New(authentication, nil, "https://daynight.example/api/v1/auth/callback").Authenticate
				t.Cleanup(func() {
					if calls != 1 {
						t.Errorf("revoked credential calls=%d, want1", calls)
					}
				})
			}
			response := startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report}))
			if terminal {
				assertProjectError(t, response, http.StatusConflict, "claim_conflict")
			} else {
				assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
			}
		})
	}
}

func TestStartupReportFreshClaimClearsPreviousEvidence(t *testing.T) {
	f := startupTaskSetup(t)
	sendStartup(t, f, startupBody(f))
	current := startupTaskModel(f.task)
	released := current
	released.Properties = taskproperty.Clone(current.Properties)
	delete(released.Properties, "worker")
	delete(released.Properties, "sessionStartup")
	released.Status, released.Version, released.UpdatedAt = model.TaskTodo, current.Version+1, current.UpdatedAt.Add(time.Second)
	released.Ready = true
	startupExpectWrite(t, f, current, nil, false, &released, nil, f.handler.principal, nil)
	f.task = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskPath(f.task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "stoppedConfirmed": true})), http.StatusOK)
	if !reflect.DeepEqual(f.task, startupTaskDocument(t, released)) {
		t.Fatal("release changed unrelated Task state")
	}
	now := released.UpdatedAt.Add(time.Second)
	claimID, workerID, worktreeID, machineID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	body := map[string]any{"version": released.Version, "claimId": claimID, "workerId": workerID, "machine": map[string]any{"id": machineID, "name": "Startup worker"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": worktreeID}
	claimed := released
	claimed.Properties = taskproperty.Clone(released.Properties)
	delete(claimed.Properties, "sessionStartup")
	claimed.Properties["worker"] = rawProperty(t, api.WorkerClaim{ClaimID: claimID, State: "active", UserID: f.handler.principal.UserID, WorkerID: workerID, Machine: api.WorkerMachine{ID: machineID, Name: "Startup worker"}, Platform: "linux", Agent: "codex", AgentControlMode: "web", WorktreeID: worktreeID, Phase: "preparing", ClaimedAt: now})
	claimed.Status, claimed.Version, claimed.UpdatedAt = model.TaskInProgress, released.Version+1, now
	claimed.Ready = false
	startupExpectWrite(t, f, released, nil, false, &claimed, &now, f.handler.principal, nil)
	next := claimHTTPWorker(t, f.handler, f.task, body)
	if next.Properties["sessionStartup"] != nil || !reflect.DeepEqual(next, startupTaskDocument(t, claimed)) {
		t.Fatal("new claim retains old startup evidence or changes unrelated Task fields")
	}
}

func TestStartupReportRejectsAnotherMemberAndForeignWorkerBinding(t *testing.T) {
	f := startupTaskSetup(t)
	current := startupTaskModel(f.task)
	other := f.handler.principal
	other.UserID, other.CredentialID = uuid.NewString(), uuid.NewString()
	startupExpectWrite(t, f, current, nil, false, nil, nil, other, nil)
	caller := taskComponentHandler(t, f.store, io.Discard, other)
	startupTaskAuthentication(t, caller)
	extendedWorkerTestHandler(caller)
	body := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	assertProjectError(t, projectRequest(caller, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusForbidden, "forbidden")
	for _, field := range []string{"workerId", "worktreeId"} {
		t.Run(field, func(t *testing.T) {
			report := startupReportValue(t, startupBody(f))
			startupExpectWrite(t, f, current, &report, false, nil, nil, f.handler.principal, nil)
			assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusConflict, "claim_conflict")
		})
	}
}
