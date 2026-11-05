package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
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

func TestStartupReportBeforeHelloPersistsAndNegotiatesCurrent(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	updated := decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{
		"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report,
	})), http.StatusOK)
	if updated.Properties["sessionStartup"] == nil {
		t.Fatal("startup report was not persisted")
	}
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	var expected map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, report)), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(current["startupReport"], expected) {
		t.Fatalf("current lost startup evidence: %#v", current)
	}
	legacy := decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if _, exists := legacy["startupReport"]; exists || len(legacy) != 2 {
		t.Fatal("legacy current response changed shape")
	}
}

func sendStartup(t *testing.T, f *sessionHTTPFixture, report map[string]any) api.Task {
	t.Helper()
	f.task = decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusOK)
	return f.task
}

func TestStartupReportOrderingIdentityAndMissingEvidence(t *testing.T) {
	f := sessionHTTPSetup(t)
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
		response := startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": bad}))
		assertProjectError(t, response, http.StatusConflict, "claim_conflict")
	}
	bad := startupBody(f)
	bad["revision"] = "2"
	assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": bad})), http.StatusConflict, "claim_conflict")
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(f.task), jsonBody(t, map[string]any{"version": f.task.Version, "properties": map[string]any{"sessionStartup": report}})), http.StatusBadRequest, "invalid_input")
}

func TestStartupReportGenerationSwitchFiltersOldEvidence(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	sendStartup(t, f, report)
	previous := "1"
	nextInstance := uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: nextInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	decodeResponse[sessionrelay.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, grant)), http.StatusOK)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("new generation displays previous startup evidence")
	}
	report["revision"] = "999"
	assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusConflict, "claim_conflict")
	report["revision"] = "1"
	report["executionGeneration"] = "2"
	report["controllerInstanceId"] = nextInstance
	sendStartup(t, f, report)
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
				f.task = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPut, taskPath(f.task)+"/status", jsonBody(t, map[string]any{"version": f.task.Version, "status": "done", "claimId": f.snapshot.ClaimID})), http.StatusOK)
			} else {
				if _, err := f.db.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.handler.principal.CredentialID); err != nil {
					t.Fatal(err)
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
	f.task = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskPath(f.task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "stoppedConfirmed": true})), http.StatusOK)
	body := workerClaimBody(f.task.Version)
	body["agentControlMode"] = "web"
	next := claimHTTPWorker(t, f.handler, f.task, body)
	if next.Properties["sessionStartup"] != nil {
		t.Fatal("new claim retains old startup evidence")
	}
}

func TestStartupReportRejectsAnotherMemberAndForeignWorkerBinding(t *testing.T) {
	f := sessionHTTPSetup(t)
	other := assignmentHTTPMember(t, f.db, f.task.ProjectID)
	caller := assigneeHTTPIdentity(t, f.db, f.handler, other)
	body := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	assertProjectError(t, projectRequest(caller, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusForbidden, "forbidden")
	for _, field := range []string{"workerId", "worktreeId"} {
		var old string
		if err := f.db.Pool.QueryRow(context.Background(), `SELECT snapshot->'identity'->>$2 FROM task_sessions WHERE id=$1`, f.snapshot.SessionID, field).Scan(&old); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,ARRAY['identity',$2],to_jsonb($3::text)) WHERE id=$1`, f.snapshot.SessionID, field, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusConflict, "claim_conflict")
		if _, err := f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,ARRAY['identity',$2],to_jsonb($3::text)) WHERE id=$1`, f.snapshot.SessionID, field, old); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStartupReportConcurrentGenerationGrantKeepsCurrentFence(t *testing.T) {
	f := sessionHTTPSetup(t)
	previous := "1"
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	grantBody := jsonBody(t, grant)
	reportBody := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	start := make(chan struct{})
	granted := make(chan *httptest.ResponseRecorder, 1)
	reported := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		<-start
		granted <- projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", grantBody)
	}()
	go func() {
		<-start
		reported <- startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", reportBody)
	}()
	close(start)
	decodeResponse[sessionrelay.GrantResult](t, <-granted, http.StatusOK)
	result := <-reported
	if result.Code != http.StatusOK && result.Code != http.StatusConflict {
		t.Fatalf("unexpected report result: %d %s", result.Code, result.Body)
	}
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("racing old report crossed generation boundary")
	}
}

func TestStartupReportNativeObservationThroughTypeScriptWorkerClient(t *testing.T) {
	f := sessionHTTPSetup(t)
	worker := apiWorker(t, f.task.Properties)
	input := map[string]any{
		"serverOrigin": f.server.URL, "token": f.handler.token, "projectId": f.task.ProjectID, "taskId": f.task.ID,
		"claimId": worker.ClaimID, "version": fmt.Sprint(f.task.Version), "sessionId": f.snapshot.SessionID,
		"executionGeneration": f.snapshot.ExecutionGeneration, "controllerInstanceId": f.registration.ControllerInstanceID,
		"workerId": worker.WorkerID, "worktreeId": worker.WorktreeID, "userId": worker.UserID, "controllerId": f.registration.ControllerID,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "..", "daynight", "test", "acceptance", "startup-client.mjs"))
	command.Stdin = strings.NewReader(jsonBody(t, input))
	output, err := command.Output()
	if err != nil {
		var failed *exec.ExitError
		if errors.As(err, &failed) {
			t.Fatalf("TypeScript startup client failed: %v\n%s", err, bytes.ReplaceAll(failed.Stderr, []byte(f.handler.token), []byte("[redacted]")))
		}
		t.Fatalf("TypeScript startup client failed: %v", err)
	}
	var result struct {
		StartupReport json.RawMessage `json:"startupReport"`
	}
	if err = json.Unmarshal(output, &result); err != nil {
		t.Fatal("TypeScript startup client returned invalid JSON", err)
	}
	report, err := sp.DecodeStartupReport(result.StartupReport)
	if err != nil || report.Startup.State != "failed" || report.Startup.ReasonCode != "native_rejected" {
		t.Fatalf("native rejection evidence mismatch: %+v %v", report, err)
	}
	current := decodeResponse[map[string]json.RawMessage](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	read, err := sp.DecodeStartupReport(current["startupReport"])
	if err != nil || !reflect.DeepEqual(read, report) {
		t.Fatalf("real Worker report did not survive service readback: %+v %v", read, err)
	}
}
