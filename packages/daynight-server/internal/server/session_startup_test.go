package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func startupBody(f *sessionHTTPFixture) map[string]any {
	return map[string]any{
		"schemaVersion": 1, "source": "worker", "sessionId": f.snapshot.SessionID, "claimId": f.snapshot.ClaimID,
		"executionGeneration": f.snapshot.ExecutionGeneration, "controllerInstanceId": f.registration.ControllerInstanceID,
		"revision": "1", "observedAt": "2026-11-05T00:00:00Z",
		"startup":  map[string]any{"state": "unknown", "reasonCode": "native_timeout"},
		"recovery": map[string]any{"state": "blocked", "reasonCode": "native_identity_missing"},
	}
}

func startupRequest(f *sessionHTTPFixture, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("X-Daynight-Startup-Version", "1")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func TestStartupReportBeforeHelloNegotiatesCurrent(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	updated := sendStartup(t, f, report)
	if updated.Properties["sessionStartup"] == nil {
		t.Fatal("startup response omitted its report")
	}
	value := startupReportValue(t, report)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(updated), &value), f.record)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	var expected map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, report)), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(current["startupReport"], expected) {
		t.Fatalf("current lost startup evidence: %#v", current)
	}
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(updated), &value), f.record)
	legacy := decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if _, exists := legacy["startupReport"]; exists || len(legacy) != 2 {
		t.Fatal("legacy current response changed shape")
	}
}

func TestFailedStartupReportHTTPReadback(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	report["startup"] = map[string]any{"state": "failed", "reasonCode": "native_rejected"}
	body := jsonBody(t, map[string]any{
		"version": f.task.Version, "claimId": f.snapshot.ClaimID, "phase": "waiting",
		"nativeSessionId": nil, "herdr": nil, "startupReport": report,
	})
	currentTask := startupTaskModel(f.task)
	value := startupReportValue(t, report)
	expectedTask := startupReportedTask(t, currentTask, value)
	expectedTask = startupReplaceWorker(t, expectedTask, func(worker *api.WorkerClaim) {
		worker.Phase = "waiting"
		worker.NativeSessionID = nil
		worker.Herdr = nil
	})
	startupExpectWrite(t, f, currentTask, &value, true, &expectedTask, nil, f.handler.principal, nil)
	updated := decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusOK)
	if !reflect.DeepEqual(updated, startupTaskDocument(t, expectedTask)) {
		t.Fatal("worker startup response changed unrelated Task fields")
	}
	worker := apiWorker(t, updated.Properties)
	if worker.ClaimID != f.snapshot.ClaimID || worker.UserID != f.handler.principal.UserID || worker.Phase != "waiting" || worker.NativeSessionID != nil || worker.Herdr != nil {
		t.Fatalf("worker update lost its identity or waiting state: %+v", worker)
	}

	startupExpectTaskRead(t, f, expectedTask)
	read := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodGet, taskPath(f.task), ""), http.StatusOK)
	readWorker := apiWorker(t, read.Properties)
	if read.Version != updated.Version || !reflect.DeepEqual(readWorker, worker) || !reflect.DeepEqual(read.Properties["sessionStartup"], updated.Properties["sessionStartup"]) {
		t.Fatal("Task read response changed the supplied worker or startup report")
	}

	startupExpectCurrent(t, f, startupSessionTask(t, expectedTask, &value), f.record)
	response := startupRequest(f, http.MethodGet, f.base+"/current", "")
	current := decodeResponse[struct {
		Status        string          `json:"status"`
		Session       sp.Snapshot     `json:"session"`
		StartupReport json.RawMessage `json:"startupReport"`
	}](t, response, http.StatusOK)
	var expected map[string]any
	var actual map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, report)), &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(current.StartupReport, &actual); err != nil {
		t.Fatal(err)
	}
	if current.Status != "registered" || current.Session.SessionID != f.snapshot.SessionID || current.Session.ClaimID != f.snapshot.ClaimID || current.Session.Identity.NativeSessionID != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("current session lost failed startup evidence or identity: %+v, report=%s", current.Session, current.StartupReport)
	}

	unauthenticated := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, f.base+"/current", nil)
	request.Header.Set("X-Daynight-Startup-Version", "1")
	request.Header.Set("X-Request-ID", "project-test")
	f.handler.ServeHTTP(unauthenticated, request)
	assertProjectError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
}

func sendStartup(t *testing.T, f *sessionHTTPFixture, report map[string]any) api.Task {
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
	f := sessionHTTPSetup(t)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), nil), f.record)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if value, exists := current["startupReport"]; !exists || value != nil {
		t.Fatal("missing evidence is not explicit null")
	}
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

// The startup HTTP fixture supplies an explicit no-owner recovery result. The
// actual service still performs recovery before changing the generation fence.
func startupExpectEmptyMediaRecovery(t *testing.T, f *sessionHTTPFixture) {
	t.Helper()
	f.mu.Lock()
	before := f.calls["ListSessionMediaLeases"]
	f.mediaRecoveryRead = func(context.Context) ([]store.SessionResourceLease, error) {
		return []store.SessionResourceLease{}, nil
	}
	f.mu.Unlock()
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if actual := f.calls["ListSessionMediaLeases"] - before; actual != 1 {
			t.Errorf("generation grant recovery listings=%d, want 1", actual)
		}
	})
}

func TestStartupReportGenerationSwitchFiltersOldEvidence(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	sendStartup(t, f, report)
	previous := "1"
	nextInstance := uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: nextInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	startupExpectEmptyMediaRecovery(t, f)
	f.store.WriteSessionCall = f.store.run
	f.mintGrant(t, grant)
	nextRecord := f.record
	nextRecord.Snapshot.ExecutionGeneration = "2"
	nextRecord.Snapshot.Identity.ControllerInstanceID = nextInstance
	old := startupReportValue(t, report)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &old), nextRecord)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("new generation displays previous startup evidence")
	}
	report["revision"] = "999"
	old = startupReportValue(t, report)
	startupExpectWrite(t, f, startupTaskModel(f.task), &old, false, nil, nil, f.handler.principal, nil)
	assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusConflict, "claim_conflict")
	report["revision"] = "1"
	report["executionGeneration"] = "2"
	report["controllerInstanceId"] = nextInstance
	sendStartup(t, f, report)
	currentReport := startupReportValue(t, report)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &currentReport), nextRecord)
	current = decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] == nil {
		t.Fatal("current generation evidence not readable")
	}
}

func TestStartupReportCannotWriteAfterCredentialRevocationOrCompletion(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoked", true: "completed"}[terminal], func(t *testing.T) {
			f := sessionHTTPSetup(t)
			report := startupBody(f)
			if terminal {
				current := startupTaskModel(f.task)
				current.Status = model.TaskDone
				current = startupReplaceWorker(t, current, func(w *api.WorkerClaim) { w.State = "completed" })
				startupExpectWrite(t, f, current, nil, false, nil, nil, f.handler.principal, nil)
			} else {
				f.store.WriteIdentityCall = func(ctx context.Context, work func(store.IdentityScope) error) (store.Completion, error) {
					dao := &startupRevokedCredential{httpAuthenticationDAO: httpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, principal: f.handler.principal, hash: secret.Hash(f.handler.token)}}
					err := work(httpAuthenticationScope{t: t, dao: dao})
					if dao.calls != 1 {
						t.Errorf("revoked credential calls=%d, want1", dao.calls)
					}
					if err != nil {
						return store.Completion{Outcome: store.TransactionNotCommitted}, err
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				}
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
	f := sessionHTTPSetup(t)
	sendStartup(t, f, startupBody(f))
	current := startupTaskModel(f.task)
	released := startupReplaceWorker(t, current, func(w *api.WorkerClaim) { w.State = "released" })
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
	f := sessionHTTPSetup(t)
	current := startupTaskModel(f.task)
	other := f.handler.principal
	other.UserID, other.CredentialID = uuid.NewString(), uuid.NewString()
	otherStore := newHTTPTestStoreForPrincipal(t, other)
	originalStore := f.store.httpTestStore
	f.store.httpTestStore = otherStore
	startupExpectWrite(t, f, current, nil, false, nil, nil, other, nil)
	caller := resourceTestServerForPrincipal(t, f.store, attachmentTestFiles(t), io.Discard, other)
	extendedWorkerTestHandler(caller)
	body := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	assertProjectError(t, projectRequest(caller, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusForbidden, "forbidden")
	f.store.httpTestStore = originalStore
	for _, field := range []string{"workerId", "worktreeId"} {
		t.Run(field, func(t *testing.T) {
			report := startupReportValue(t, startupBody(f))
			startupExpectWrite(t, f, current, &report, false, nil, nil, f.handler.principal, nil)
			assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusConflict, "claim_conflict")
		})
	}
}

func TestStartupReportConcurrentGenerationGrantKeepsCurrentFence(t *testing.T) {
	f := sessionHTTPSetup(t)
	previous := "1"
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	grantBody := jsonBody(t, grant)
	report := startupReportValue(t, startupBody(f))
	reportBody := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	matched, grantFinished := make(chan struct{}), make(chan struct{})
	var release sync.Once
	reportDone := make(chan struct{})
	finishGrant := func() { release.Do(func() { close(grantFinished) }) }
	t.Cleanup(func() {
		finishGrant()
		select {
		case <-reportDone:
		case <-time.After(5 * time.Second):
			t.Error("startup report request did not drain")
		}
	})
	startupExpectWrite(t, f, startupTaskModel(f.task), &report, false, nil, nil, f.handler.principal, func() {
		close(matched)
		select {
		case <-grantFinished:
		case <-time.After(5 * time.Second):
			t.Error("concurrent grant did not complete")
			panic("grant timeout")
		}
	})
	reported := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		defer close(reportDone)
		reported <- startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", reportBody)
	}()
	select {
	case <-matched:
	case <-time.After(5 * time.Second):
		t.Fatal("report did not reach its Session fence")
	}
	startupExpectEmptyMediaRecovery(t, f)
	f.store.WriteSessionCall = f.store.run
	decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", grantBody), http.StatusOK)
	finishGrant()
	var result *httptest.ResponseRecorder
	select {
	case result = <-reported:
	case <-time.After(5 * time.Second):
		t.Fatal("startup report response did not complete")
	}
	assertProjectError(t, result, http.StatusConflict, "claim_conflict")
	nextRecord := f.record
	nextRecord.Snapshot.ExecutionGeneration, nextRecord.Snapshot.Identity.ControllerInstanceID = "2", grant.ControllerInstanceID
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &report), nextRecord)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("racing old report crossed generation boundary")
	}
}
