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
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

func TestBotDeletionHTTPBoundSessionAndReceiptReconciliation(t *testing.T) {
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
	project := decodeResponse[api.Project](t, projectRequest(h, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Independent task", RepoURL: "https://example.test/independent", ExpectedUserID: h.principal.UserID})), 201)
	taskCollection := "/api/v1/projects/" + project.ID + "/tasks"
	task := decodeResponse[api.Task](t, projectRequest(h, "POST", taskCollection, `{"title":"Independent task","description":"Preserve content"}`), 201)
	taskPath := taskCollection + "/" + task.ID
	if read := decodeResponse[api.Task](t, projectRequest(h, "GET", taskPath, ""), 200); !reflect.DeepEqual(read, task) {
		t.Fatal("independent task did not persist before Bot deletion")
	}
	worker := uuid.NewString()
	reportSnapshotHTTP(t, h, worker, workerSnapshotReportBody())
	bot := seedHTTPBot(t, db, h, worker)
	path := "/api/v1/me/bots/" + bot.ID
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	instructions := "Use the Daynight CLI."
	body := map[string]any{"botVersion": "1", "registration": reg, "configuration": bot.ResolvedConfiguration, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	registered := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(h, "POST", base+"/register", jsonBody(t, body)), 200)
	deletionID := uuid.NewString()
	deletion := jsonBody(t, map[string]any{"ifVersion": "2", "deletionId": deletionID})
	decodeResponse[sp.Snapshot](t, projectRequest(h, "GET", "/api/v1/test-sessions/"+registered.Session.SessionID, ""), 200)
	removed := decodeResponse[api.Bot](t, projectRequest(h, "DELETE", path, deletion), 200)
	if removed.BotDefinition != nil || removed.Deletion == nil || removed.Deletion.DeletionID != deletionID || removed.Deletion.WorkerCleanup.State != "pending" {
		t.Fatalf("bound deletion did not retain a private cleanup obligation: %+v", removed)
	}
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+registered.Session.SessionID, ""), 409, "resource_conflict")
	missingStop := jsonBody(t, map[string]any{"deletionId": deletionID, "stop": nil, "result": map[string]any{"state": "completed", "code": nil}})
	assertProjectError(t, projectRequest(h, "POST", base+"/deletion-complete", missingStop), 409, "session_conflict")
	failure := jsonBody(t, map[string]any{"deletionId": deletionID, "stop": nil, "result": map[string]any{"state": "failed", "code": "process_stop_unconfirmed"}})
	failed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", failure), 200)
	if failed.Deletion.WorkerCleanup.State != "failed" || failed.Deletion.ServerCleanup.State == "completed" {
		t.Fatal("failed Worker cleanup was reported as completed")
	}
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: registered.Session.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	receipt := jsonBody(t, map[string]any{"deletionId": deletionID, "stop": stop, "result": map[string]any{"state": "completed", "code": nil}})
	request := httptest.NewRequest("POST", base+"/deletion-complete", strings.NewReader(receipt))
	request.Header.Set("Content-Type", "application/json")
	authorizeResourceRequest(h, request)
	lost := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(lost, request)
	if lost.calls != 1 || lost.Body.Len() != 0 {
		t.Fatal("completion response-loss fixture did not lose response")
	}
	detail := decodeResponse[api.Bot](t, projectRequest(h, "GET", path, ""), 200)
	completed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", receipt), 200)
	if completed.BotDefinition != nil || completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" || detail.Version != completed.Version {
		t.Fatalf("receipt replay lost completion: %+v %+v", detail, completed)
	}
	duplicateDelete := decodeResponse[api.Bot](t, projectRequest(h, "DELETE", path, deletion), 200)
	if duplicateDelete.Version != completed.Version || duplicateDelete.Deletion.ServerCleanup.State != "completed" {
		t.Fatal("original delete retry changed its completed result")
	}
	inventory := decodeResponse[api.BotPage](t, projectRequest(h, "GET", "/api/v1/me/workers/"+worker+"/bots", ""), 200)
	if len(inventory.Items) != 0 {
		t.Fatal("completed deletion remains in Worker inventory")
	}
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+registered.Session.SessionID, ""), 404, "not_found")
	if read := decodeResponse[api.Task](t, projectRequest(h, "GET", taskPath, ""), 200); !reflect.DeepEqual(read, task) {
		t.Fatalf("Bot deletion changed an independent task: %+v", read)
	}
	t.Run("unbound cleanup", func(t *testing.T) {
		bot := seedHTTPBot(t, db, h, worker)
		path := "/api/v1/me/bots/" + bot.ID
		base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID + "/deletion-complete"
		if read := decodeResponse[api.Bot](t, projectRequest(h, "GET", path, ""), 200); read.BotDefinition == nil ||
			read.SessionID != nil || read.TestExecutionID != nil {
			t.Fatalf("cleanup fixture is bound to a Session: %+v", read)
		}
		id := uuid.NewString()
		receipt := botUnboundReceiptBody(id)
		foreign := strings.Replace(base, worker, uuid.NewString(), 1)
		assertProjectError(t, projectRequest(h, "POST", foreign, receipt), 403, "forbidden")
		intent := decodeResponse[api.Bot](t, projectRequest(h, "DELETE", path, `{"ifVersion":"1","deletionId":"`+id+`"}`), 200)
		if intent.BotDefinition != nil || intent.Deletion == nil || intent.Deletion.DeletionID != id ||
			intent.Deletion.WorkerCleanup.State != "pending" || intent.Deletion.ServerCleanup.State != "pending" {
			t.Fatalf("unbound deletion did not retain pending obligations: %+v", intent)
		}
		done := decodeResponse[api.Bot](t, projectRequest(h, "POST", base, receipt), 200)
		if done.BotDefinition != nil || done.Deletion == nil || done.Deletion.DeletionID != id || done.Deletion.RequestedVersion != 1 ||
			done.Version <= intent.Version || done.Deletion.WorkerCleanup.State != "completed" || done.Deletion.ServerCleanup.State != "completed" {
			t.Fatalf("unbound cleanup did not complete: %+v", done)
		}
		if read := decodeResponse[api.Bot](t, projectRequest(h, "GET", path, ""), 200); !reflect.DeepEqual(read, done) {
			t.Fatalf("unbound cleanup did not persist: %+v", read)
		}
	})
}

func botUnboundReceiptBody(id string) string {
	return `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null}}`
}

func TestBotDeletionHTTPStrictReceiptAndAdmission(t *testing.T) {
	f := newBotExpiryFixture(t, defaultHTTPPrincipal())
	const worker, bot, id = botDefinitionsWorker, botDefinitionsID, botDefinitionsIntent
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot + "/deletion-complete"
	valid := botUnboundReceiptBody(id)
	request := func(path, body string, c *botExpiryCall) *httptest.ResponseRecorder {
		t.Helper()
		return f.runtimeRequest("POST", path, body, botRuntimeJSON, true, c)
	}
	for _, body := range []string{`null`, `{}`, valid + ` {}`, `{"deletionId":"` + id + `","deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null}}`, `{"deletionId":null,"stop":null,"result":{"state":"completed","code":null}}`, `{"deletionId":"` + id + `","stop":{},"result":{"state":"completed","code":null}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed"}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":null,"code":null}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null,"extra":true}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"failed","code":"\ud800"}}`} {
		assertProjectError(t, request(base, body, nil), 400, "invalid_input")
	}
	assertProjectError(t, request(base, strings.Replace(valid, `"code":null`, `"code":123`, 1), nil), 400, "invalid_input")
	assertProjectError(t, f.runtimeRequest("POST", base, valid, "", true, nil), 400, "invalid_input")
	method := f.runtimeRequest("GET", base, "", botRuntimeJSON, true, nil)
	assertProjectError(t, method, 405, "method_not_allowed")
	if method.Header().Get("Allow") != "POST" {
		t.Fatalf("unexpected completion methods: %v", method.Header())
	}
	assertProjectError(t, f.runtimeRequest("POST", base, valid, botRuntimeJSON, false, nil), 401, "unauthenticated")
	assertProjectError(t, request(base+"?unknown=1", valid, nil), 400, "invalid_input")

	call := func(worker string, result model.Bot, err error) *botExpiryCall {
		return &botExpiryCall{method: "CompleteBotDeletion", worker: worker, bot: bot,
			input:  botservice.BotDeletionReceipt{DeletionID: id, Result: model.BotCleanupResult{State: "completed"}},
			result: result, err: err}
	}
	const foreign = "b0000000-0000-4000-8000-000000000092"
	assertProjectError(t, request(strings.Replace(base, worker, foreign, 1), valid,
		call(foreign, model.Bot{}, &model.Fault{Code: "forbidden", Message: "Session access is not available."})), 403, "forbidden")

	response := request(base, valid, call(worker, model.Bot{
		ID: bot, WorkerID: worker, OwnerUserID: f.principal.UserID, Version: 4, Name: "private definition",
		ResolvedConfiguration: model.BotConfiguration{Cwd: "/private/bot-work"},
		Deletion: &model.BotDeletion{DeletionID: id, RequestedVersion: 1, ReceiptDigest: "private-digest",
			WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "completed"}},
	}, nil))
	done := decodeResponse[api.Bot](t, response, 200)
	want := api.Bot{ID: bot, WorkerID: worker, Version: 4,
		Deletion: &api.BotDeletion{DeletionID: id, RequestedVersion: 1,
			WorkerCleanup: api.BotResult{State: "completed"}, ServerCleanup: api.BotResult{State: "completed"}}}
	if !reflect.DeepEqual(done, want) || response.Body.String() != jsonBody(t, want) {
		t.Fatalf("unbound cleanup receipt projection: %s", response.Body)
	}
}
