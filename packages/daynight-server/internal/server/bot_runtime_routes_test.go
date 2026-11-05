package server

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestBotRuntimeHTTPRegistrationAndReconciliation(t *testing.T) {
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
	worker := uuid.NewString()
	reportSnapshotHTTP(t, h, worker, workerSnapshotReportBody())
	bot := seedHTTPBot(t, db, h, worker)
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	instructions := "Use the Daynight CLI."
	body := map[string]any{"botVersion": "1", "registration": reg, "configuration": bot.ResolvedConfiguration, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	type result struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}
	request := httptest.NewRequest("POST", base+"/register", strings.NewReader(jsonBody(t, body)))
	request.Header.Set("Content-Type", "application/json")
	authorizeResourceRequest(h, request)
	writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(writer, request)
	if writer.calls != 1 || writer.Body.Len() != 0 {
		t.Fatal("response-loss fixture did not lose response")
	}
	first := decodeResponse[result](t, projectRequest(h, "POST", base+"/register", jsonBody(t, body)), 200)
	second := decodeResponse[result](t, projectRequest(h, "POST", base+"/register", jsonBody(t, body)), 200)
	if first.Session.SessionID == "" || first.Session.SessionID != second.Session.SessionID || first.Bot.Version != 2 || second.Bot.Version != 2 || first.Session.TestExecutionID != reg.TestExecutionID || first.Session.ClaimID != "" {
		t.Fatalf("unstable registration: %+v %+v", first, second)
	}
	detail := decodeResponse[map[string]any](t, projectRequest(h, "GET", "/api/v1/me/bots/"+bot.ID, ""), 200)
	if detail["testExecutionId"] != reg.TestExecutionID || detail["sessionId"] != first.Session.SessionID {
		t.Fatalf("missing stable reference: %v", detail)
	}
	grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: reg.TestExecutionID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	grantBody := map[string]any{"botVersion": "2", "grant": grant, "nativeSessionId": nil}
	decodeResponse[map[string]any](t, projectRequest(h, "POST", base+"/grant", jsonBody(t, grantBody)), 200)
	assertProjectError(t, projectRequest(h, "POST", "/api/v1/test-sessions/"+first.Session.SessionID+"/controller-grant", jsonBody(t, grant)), 403, "forbidden")
	for _, suffix := range []string{"register", "grant", "report"} {
		assertProjectError(t, projectRequest(h, "GET", base+"/"+suffix, ""), 405, "method_not_allowed")
		assertProjectError(t, projectRequest(h.Handler, "POST", base+"/"+suffix, `{}`), 401, "unauthenticated")
		assertProjectError(t, projectRequest(h, "POST", base+"/"+suffix+"?unknown=1", `{}`), 400, "invalid_input")
	}
}

func TestBotRuntimeHTTPPreflightFailureAndStrictInputs(t *testing.T) {
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
	worker := uuid.NewString()
	reportSnapshotHTTP(t, h, worker, workerSnapshotReportBody())
	bot := seedHTTPBot(t, db, h, worker)
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
	report := map[string]any{"botVersion": "1", "fence": nil, "controllerId": "", "controllerInstanceId": "", "nativeSessionId": nil, "result": map[string]any{"state": "failed", "code": "directory_missing"}}
	result := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/report", jsonBody(t, report)), 200)
	if result.Version != 2 || result.StartupResult.State != "failed" || result.SessionID != nil {
		t.Fatalf("preflight: %+v", result)
	}
	assertProjectError(t, projectRequest(h, "POST", base+"/report", jsonBody(t, report)), 409, "version_conflict")
	report["botVersion"] = "2"
	result = decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/report", jsonBody(t, report)), 200)
	if result.Version != 2 {
		t.Fatal("same failure changed version")
	}
	for _, suffix := range []string{"register", "grant", "report"} {
		for _, body := range []string{`null`, `{}`, `{"botVersion":"01"}`, `{"botVersion":"1","unknown":true}`} {
			assertProjectError(t, projectRequest(h, "POST", base+"/"+suffix, body), 400, "invalid_input")
		}
		request := httptest.NewRequest("POST", base+"/"+suffix, strings.NewReader(`{}`))
		request.Header.Set("X-Request-ID", "project-test")
		authorizeResourceRequest(h, request)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		assertProjectError(t, response, 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(h, "POST", "/api/v1/me/workers/bad/bots/"+bot.ID+"/report", jsonBody(t, report)), 400, "invalid_input")
	assertProjectError(t, projectRequest(h, "POST", "/api/v1/me/workers/"+uuid.NewString()+"/bots/"+bot.ID+"/report", jsonBody(t, report)), 403, "forbidden")
}
