package bot_test

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotDeletionHTTPBoundSessionAndReceiptReconciliation(t *testing.T) {
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
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
}

func TestBotDeletionHTTPStrictReceiptAndAdmission(t *testing.T) {
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
	worker := uuid.NewString()
	reportSnapshotHTTP(t, h, worker, workerSnapshotReportBody())
	bot := seedHTTPBot(t, db, h, worker)
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID + "/deletion-complete"
	id := uuid.NewString()
	valid := `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null}}`
	for _, body := range []string{`null`, `{}`, valid + ` {}`, `{"deletionId":"` + id + `","deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null}}`, `{"deletionId":null,"stop":null,"result":{"state":"completed","code":null}}`, `{"deletionId":"` + id + `","stop":{},"result":{"state":"completed","code":null}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed"}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":null,"code":null}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"completed","code":null,"extra":true}}`, `{"deletionId":"` + id + `","stop":null,"result":{"state":"failed","code":"\ud800"}}`} {
		assertProjectError(t, projectRequest(h, "POST", base, body), 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(h, "POST", base, strings.Replace(valid, `"code":null`, `"code":123`, 1)), 400, "invalid_input")
	request := httptest.NewRequest("POST", base, strings.NewReader(valid))
	request.Header.Set("X-Request-ID", "project-test")
	authorizeResourceRequest(h, request)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	assertProjectError(t, projectRequest(h, "GET", base, ""), 405, "method_not_allowed")
	assertProjectError(t, projectRequest(h.Handler, "POST", base, valid), 401, "unauthenticated")
	assertProjectError(t, projectRequest(h, "POST", base+"?unknown=1", valid), 400, "invalid_input")
	assertProjectError(t, projectRequest(h, "POST", strings.Replace(base, worker, uuid.NewString(), 1), valid), 403, "forbidden")
	decodeResponse[api.Bot](t, projectRequest(h, "DELETE", "/api/v1/me/bots/"+bot.ID, `{"ifVersion":"1","deletionId":"`+id+`"}`), 200)
	done := decodeResponse[api.Bot](t, projectRequest(h, "POST", base, valid), 200)
	if done.Deletion.WorkerCleanup.State != "completed" || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatal("unbound cleanup did not complete")
	}
}
