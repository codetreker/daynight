package bot_test

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
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
	t.Run("unbound preflight failure", func(t *testing.T) {
		bot := seedHTTPBot(t, db, h, worker)
		base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID + "/report"
		path := "/api/v1/me/bots/" + bot.ID
		report := botPreflightReportBody("1")
		result := decodeResponse[api.Bot](t, projectRequest(h, "POST", base, report), 200)
		if result.BotDefinition == nil || result.Version != 2 || result.StartupResult.State != "failed" ||
			result.StartupResult.Code == nil || *result.StartupResult.Code != "directory_missing" ||
			result.SessionID != nil || result.TestExecutionID != nil {
			t.Fatalf("preflight failure changed binding or startup result: %+v", result)
		}
		assertProjectError(t, projectRequest(h, "POST", base, report), 409, "version_conflict")
		if read := decodeResponse[api.Bot](t, projectRequest(h, "GET", path, ""), 200); !reflect.DeepEqual(read, result) {
			t.Fatalf("preflight failure did not persist unchanged after stale report: %+v", read)
		}
		report = botPreflightReportBody("2")
		replay := decodeResponse[api.Bot](t, projectRequest(h, "POST", base, report), 200)
		if !reflect.DeepEqual(replay, result) {
			t.Fatalf("same failure changed the Bot: %+v", replay)
		}
		foreign := strings.Replace(base, worker, uuid.NewString(), 1)
		assertProjectError(t, projectRequest(h, "POST", foreign, report), 403, "forbidden")
		if read := decodeResponse[api.Bot](t, projectRequest(h, "GET", path, ""), 200); !reflect.DeepEqual(read, result) {
			t.Fatalf("replayed or forbidden report changed the persisted Bot: %+v", read)
		}
	})
}

func botPreflightReportBody(version string) string {
	return `{"botVersion":"` + version + `","fence":null,"controllerId":"","controllerInstanceId":"","nativeSessionId":null,"result":{"state":"failed","code":"directory_missing"}}`
}

const botRuntimeJSON = "application/json; charset=UTF-8"

func TestBotRuntimeHTTPPreflightFailureAndStrictInputs(t *testing.T) {
	principal := defaultHTTPPrincipal()
	f := newBotExpiryFixture(t, principal)
	const worker, bot = botDefinitionsWorker, botDefinitionsID
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot
	instant := time.Date(2026, 11, 18, 12, 0, 0, 0, time.FixedZone("fixture", 3600))
	failureCode := "directory_missing"
	result := func() model.Bot {
		return model.Bot{ID: bot, WorkerID: worker, OwnerUserID: principal.UserID, Name: "长期助手", Version: 2, CreationOrder: 1,
			ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}},
			StartupResult:         model.BotStartupResult{State: "failed", Code: &failureCode}, CreatedAt: instant, UpdatedAt: instant.Add(time.Second)}
	}
	report := func(worker string, version int64, err error) *botExpiryCall {
		return &botExpiryCall{method: "ReportBot", worker: worker, bot: bot, input: sessioncore.BotReport{
			BotVersion: version, Result: model.BotStartupResult{State: "failed", Code: &failureCode},
		}, result: result(), err: err}
	}
	request := func(path, body string, call *botExpiryCall) *httptest.ResponseRecorder {
		t.Helper()
		return f.runtimeRequest("POST", path, body, botRuntimeJSON, true, call)
	}
	want := api.Bot{ID: bot, WorkerID: worker, Version: 2, BotDefinition: &api.BotDefinition{
		OwnerUserID: principal.UserID, Name: "长期助手", CreationOrder: 1,
		ResolvedConfiguration: api.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}},
		StartupResult:         api.BotResult{State: "failed", Code: &failureCode}, CreatedAt: instant.UTC(), UpdatedAt: instant.Add(time.Second).UTC(),
	}}
	check := func(response *httptest.ResponseRecorder) {
		t.Helper()
		got := decodeResponse[api.Bot](t, response, 200)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("preflight failure projection: %s", response.Body)
		}
	}
	check(request(base+"/report", botPreflightReportBody("1"), report(worker, 1, nil)))
	assertProjectError(t, request(base+"/report", botPreflightReportBody("1"), report(worker, 1,
		&model.Fault{Code: "version_conflict", Message: "Bot version has changed."})), 409, "version_conflict")
	check(request(base+"/report", botPreflightReportBody("2"), report(worker, 2, nil)))
	for _, suffix := range []string{"register", "grant", "report"} {
		for _, body := range []string{`null`, `{}`, `{"botVersion":"01"}`, `{"botVersion":"1","unknown":true}`} {
			assertProjectError(t, request(base+"/"+suffix, body, nil), 400, "invalid_input")
		}
		assertProjectError(t, f.runtimeRequest("POST", base+"/"+suffix, `{}`, "", true, nil), 400, "invalid_input")
	}
	assertProjectError(t, request("/api/v1/me/workers/bad/bots/"+bot+"/report", botPreflightReportBody("2"), nil), 400, "invalid_input")
	const foreign = "b0000000-0000-4000-8000-000000000091"
	assertProjectError(t, request(strings.Replace(base, worker, foreign, 1)+"/report", botPreflightReportBody("2"),
		report(foreign, 2, &model.Fault{Code: "forbidden", Message: "Session access is not available."})), 403, "forbidden")
}
