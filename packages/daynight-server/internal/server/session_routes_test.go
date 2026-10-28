package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
)

func TestSessionRoutesExposeOnlyCurrentClaim(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Session route")
	response := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/sessions/current", ""), http.StatusOK)
	if response["status"] != "not_applicable" || response["claimId"] != nil {
		t.Fatalf("unexpected current session: %v", response)
	}
}

func TestSessionRoutesCapabilitiesRequireAuthentication(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	response := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodGet, "/api/v1/session-capabilities", ""), http.StatusOK)
	if response["protocol"] != sp.Protocol || response["schemaVersion"] != float64(1) || response["projectionVersion"] != float64(1) || len(response) != 4 {
		t.Fatalf("unexpected capabilities: %v", response)
	}
	providers, ok := response["providers"].([]any)
	if !ok || len(providers) != 3 || providers[0] != "codex" || providers[1] != "claude" || providers[2] != "copilot" {
		t.Fatalf("unexpected providers: %v", providers)
	}
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodDelete} {
		response := projectRequest(handler, method, "/api/v1/session-capabilities", "")
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
			t.Fatalf("capability method %s: %d", method, response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/session-capabilities", nil)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatal("anonymous capability discovery accepted")
	}
	if response := projectRequest(handler, http.MethodGet, "/api/v1/session-capabilities?unknown=1", ""); response.Code != http.StatusBadRequest {
		t.Fatal("unknown capability query accepted")
	}
}

type sessionHTTPFixture struct {
	db           *store.Store
	handler      *resourceTestHandler
	server       *httptest.Server
	application  *sessionApplication
	task         api.Task
	base         string
	registration sp.Registration
	snapshot     sp.Snapshot
	grant        sessionrelay.GrantResult
}

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{db: projectTestStore(t)}
	f.handler = projectTestHandler(t, f.db, io.Discard)
	project := taskProject(t, f.handler)
	f.task = updateHTTPTask(t, f.handler, createHTTPTask(t, f.handler, project.ID, "Web session"), map[string]any{"allowAgents": true})
	body := workerClaimBody(f.task.Version)
	body["agentControlMode"] = "web"
	f.task = claimHTTPWorker(t, f.handler, f.task, body)
	f.base = taskPath(f.task) + "/sessions"
	w := f.task.Properties.Worker
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: w.ClaimID, WorkerID: w.WorkerID, WorktreeID: w.WorktreeID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	result := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
	f.snapshot = result.Session
	f.grant = f.mint(t, "bootstrap")
	application, err := New(Dependencies{Store: f.db, Files: attachmentTestFiles(t)}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	f.application = application.(*sessionApplication)
	f.server = httptest.NewServer(RequestLogging(testLogger(), application))
	t.Cleanup(f.server.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return f
}
func (f *sessionHTTPFixture) mint(t *testing.T, kind string) sessionrelay.GrantResult {
	t.Helper()
	return decodeResponse[sessionrelay.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind})), http.StatusOK)
}
func sessionDial(t *testing.T, serverURL, path, token string, extra http.Header) *websocket.Conn {
	t.Helper()
	header := extra.Clone()
	if header == nil {
		header = make(http.Header)
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.Replace(serverURL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("WebSocket upgrade %d: %v", status, err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}
func sessionWSWrite(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(jsonBody(t, value))); err != nil {
		t.Fatal(err)
	}
}
func sessionWSRead(t *testing.T, conn *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		t.Fatalf("invalid frame %s", data)
	}
	return result
}
func sessionWSKind(t *testing.T, conn *websocket.Conn, kind string) map[string]json.RawMessage {
	t.Helper()
	for range 30 {
		frame := sessionWSRead(t, conn)
		var actual string
		_ = json.Unmarshal(frame["type"], &actual)
		if actual == kind {
			return frame
		}
	}
	t.Fatalf("missing frame %s", kind)
	return nil
}
func (f *sessionHTTPFixture) controller(t *testing.T, epoch string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	return conn, snapshot
}

func TestSessionRoutesRelayPersistsAcrossHTTPInstances(t *testing.T) {
	f := sessionHTTPSetup(t)
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	path := f.base + "/" + snapshot.SessionID
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	first := sessionWSKind(t, browser, "snapshot")
	var initialCursor, user string
	_ = json.Unmarshal(first["cursor"], &initialCursor)
	_ = json.Unmarshal(first["userId"], &user)
	if initialCursor == "" || user != f.handler.principal.UserID {
		t.Fatal("missing browser identity or cursor")
	}
	initial, err := sp.DecodeSnapshot(first["snapshot"])
	if err != nil || initial.Operations.CanSend {
		t.Fatalf("initial gate bypassed %v", err)
	}
	native := "native-session"
	entryID, resourceID := uuid.NewString(), uuid.NewString()
	content := []byte("persistent resource")
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	media := "text/plain"
	size := "19"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	events := sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{
		{SourceSeq: "1", Kind: "state", Payload: json.RawMessage(jsonBody(t, state))},
		{SourceSeq: "2", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, map[string]any{"entryId": entryID, "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Saved output"}, map[string]any{"type": "resource", "resourceId": resourceID, "label": "Output"}}}))},
		{SourceSeq: "3", Kind: "resource", Payload: json.RawMessage(jsonBody(t, sp.Resource{ResourceID: resourceID, Status: "pending", Name: "output.txt", MediaType: &media, ByteLength: &size, SHA256: &hash}))},
	}}
	sessionWSWrite(t, controller, events)
	sessionWSKind(t, controller, "events_ack")
	// Retrying a committed batch after a lost ACK must not duplicate history.
	sessionWSWrite(t, controller, events)
	sessionWSKind(t, controller, "events_ack")
	page := decodeResponse[struct {
		Items []json.RawMessage `json:"items"`
	}](t, projectRequest(f.handler, http.MethodGet, path+"/timeline?direction=tail&limit=10", ""), http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatalf("duplicated timeline entries: %d", len(page.Items))
	}
	if _, err = sp.DecodeTimeline(page.Items[0]); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/v1/controller-resources/"+resourceID, strings.NewReader(string(content)))
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	request.Header.Set("Daynight-Connection-Epoch", snapshot.ConnectionEpoch)
	upload := httptest.NewRecorder()
	f.handler.ServeHTTP(upload, request)
	decodeResponse[map[string]any](t, upload, http.StatusOK)
	other := projectTestHandler(t, f.db, io.Discard)
	download := projectRequest(other, http.MethodGet, path+"/resources/"+resourceID+"/content", "")
	if download.Code != http.StatusOK || download.Body.String() != string(content) || download.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("cross-instance resource: %d %s", download.Code, download.Body)
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "session-http", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Continue"}],"expectedTurnId":null}`)}
	accepted := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
		URL       string       `json:"operationUrl"`
	}](t, projectRequest(other, http.MethodPost, path+"/commands", jsonBody(t, command)), http.StatusAccepted)
	if accepted.Operation.State != "accepted" || accepted.URL == "" {
		t.Fatal("HTTP acknowledged native completion")
	}
	offer := sessionWSKind(t, controller, "operation_offer")
	var offered sp.Command
	if json.Unmarshal(offer["command"], &offered) != nil || offered.OperationID != command.OperationID {
		t.Fatal("wrong native intent offered")
	}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	sessionWSKind(t, controller, "operation_authorized")
	accepted.Operation.State = "confirmed"
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "operation_receipt", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, Operation: &accepted.Operation})
	sessionWSKind(t, controller, "receipt_ack")
	got := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, projectRequest(other, http.MethodGet, accepted.URL, ""), http.StatusOK)
	if got.Operation.State != "confirmed" {
		t.Fatal("receipt not durable")
	}
	reconnected := sessionDial(t, f.server.URL, path+"/channel?after="+initialCursor, f.handler.token, nil)
	replay := sessionWSKind(t, reconnected, "snapshot")
	var replayCursor string
	_ = json.Unmarshal(replay["cursor"], &replayCursor)
	if replayCursor != initialCursor {
		t.Fatal("reconnect skipped requested cursor")
	}
	frame := sessionWSKind(t, reconnected, "event")
	if _, err := sp.DecodeEvent(frame["event"]); err != nil {
		t.Fatal("invalid durable event", err)
	}
	if _, err = f.db.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.handler.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err = controller.Read(ctx)
		if err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		t.Fatal("revoked controller grant retained access")
	}
}

func TestSessionRoutesRejectInvalidHTTPInputs(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID
	for _, input := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodPost, f.base, `{}`, 400}, {http.MethodPost, f.base + "?unknown=1", `{}`, 400},
		{http.MethodPost, path + "/controller-grant", `{}`, 400}, {http.MethodPost, path + "/controller-grant?x=1", `{}`, 400},
		{http.MethodPost, path + "/commands", `{}`, 400}, {http.MethodPost, path + "/commands?x=1", `{}`, 400},
		{http.MethodGet, f.base + "/current?x=1", "", 400},
		{http.MethodGet, path + "/timeline?limit=201", "", 400}, {http.MethodGet, path + "/timeline?direction=before", "", 400}, {http.MethodGet, path + "/timeline?x=1", "", 400},
		{http.MethodGet, path + "/operations/" + uuid.NewString() + "?x=1", "", 400},
		{http.MethodGet, path + "/resources/" + uuid.NewString() + "/content?x=1", "", 400},
		{http.MethodGet, path + "/resources/" + uuid.NewString() + "/content", "", 404},
		{http.MethodGet, strings.Replace(f.base, "/projects/"+f.task.ProjectID, "/projects/invalid", 1) + "/current", "", 400},
		{http.MethodDelete, f.base, "", 405}, {http.MethodHead, f.base + "/current", "", 405},
	} {
		response := projectRequest(f.handler, input.method, input.path, input.body)
		if response.Code != input.status {
			t.Fatalf("%s %s: %d %s", input.method, input.path, response.Code, response.Body)
		}
	}
	for _, test := range []struct {
		body        io.Reader
		contentType string
		status      int
	}{
		{strings.NewReader("{}"), "text/plain", 400},
		{strings.NewReader(strings.Repeat("x", sp.MaxFrameBytes+1)), "application/json", 413},
		{&attachmentFailingBody{readErr: errors.New("broken body")}, "application/json", 400},
	} {
		request := httptest.NewRequest(http.MethodPost, f.base, test.body)
		request.Header.Set("Authorization", "Bearer "+f.handler.token)
		request.Header.Set("Content-Type", test.contentType)
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("body rejection: %d %s", response.Code, response.Body)
		}
	}
	command := sp.Command{Fence: f.snapshot.Fence, Protocol: sp.Protocol, RequestID: "initial", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Too soon"}],"expectedTurnId":null}`)}
	response := projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command))
	if response.Code != 409 {
		t.Fatalf("initial gate HTTP status: %d %s", response.Code, response.Body)
	}
	for _, test := range []struct {
		path, token, epoch string
		body               io.Reader
		status             int
	}{
		{"/api/v1/controller-resources/" + uuid.NewString(), "", "1", strings.NewReader(""), 401},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.handler.token, "1", strings.NewReader(""), 401},
		{"/api/v1/controller-resources/invalid", f.grant.Token, "1", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString() + "?x=1", f.grant.Token, "1", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "01", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "1", strings.NewReader(strings.Repeat("x", sp.MaxResourceBytes+1)), 413},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "1", &attachmentFailingBody{readErr: errors.New("broken body")}, 400},
	} {
		request := httptest.NewRequest(http.MethodPut, test.path, test.body)
		if test.token != "" {
			request.Header.Set("Authorization", "Bearer "+test.token)
		}
		if test.epoch != "" {
			request.Header.Set("Daynight-Connection-Epoch", test.epoch)
		}
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("upload rejection %s: %d %s", test.path, response.Code, response.Body)
		}
	}
	for _, code := range []string{"session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict"} {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		response := httptest.NewRecorder()
		writeError(response, request, testLogger(), "session", "test", &service.Fault{Code: code, Message: "Conflict"})
		if response.Code != 409 {
			t.Fatalf("%s mapped to %d", code, response.Code)
		}
	}
}

func TestSessionRoutesBrowserRespondsToPingAndContinuesReceivingEvents(t *testing.T) {
	f := sessionHTTPSetup(t)
	sourceEpoch := uuid.NewString()
	controller, snapshot := f.controller(t, sourceEpoch)
	path := f.base + "/" + snapshot.SessionID + "/channel"
	browser := sessionDial(t, f.server.URL, path, f.handler.token, nil)
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type readResult struct {
		data []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		// Read handles ping control frames and sends pong while waiting for the
		// next application event on this same connection.
		_, data, err := browser.Read(ctx)
		result <- readResult{data: data, err: err}
	}()
	select {
	case early := <-result:
		t.Fatalf("idle browser closed or received unexpected data before ping: %s, %v", early.data, early.err)
	case <-time.After(11 * time.Second):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	entryID := uuid.NewString()
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: sourceEpoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{
		{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, map[string]any{"entryId": entryID, "revision": "1", "kind": "reasoning", "text": "Output after the browser answered the server ping"}))},
	}})
	sessionWSKind(t, controller, "events_ack")
	select {
	case received := <-result:
		if received.err != nil {
			t.Fatalf("browser could not receive after ping: %v", received.err)
		}
		var frame map[string]json.RawMessage
		if err := json.Unmarshal(received.data, &frame); err != nil || string(frame["type"]) != `"event"` {
			t.Fatalf("expected an application event after ping: %s, %v", received.data, err)
		}
		event, err := sp.DecodeEvent(frame["event"])
		if err != nil || event.Kind != "timeline_upsert" || event.HistoryEpoch != snapshot.HistoryEpoch {
			t.Fatalf("invalid event after ping: %+v, %v", event, err)
		}
		entry, err := sp.DecodeTimeline(event.Payload)
		if err != nil || entry.EntryID != entryID {
			t.Fatalf("wrong entry after ping: %+v, %v", entry, err)
		}
	case <-ctx.Done():
		t.Fatal("browser did not receive an event after ping: ", ctx.Err())
	}
}

func TestSessionRoutesBrowserHistoryResetClosesOldCursorAndRecovers(t *testing.T) {
	f := sessionHTTPSetup(t)
	sourceEpoch := uuid.NewString()
	controller, snapshot := f.controller(t, sourceEpoch)
	path := f.base + "/" + snapshot.SessionID
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	first := sessionWSKind(t, browser, "snapshot")
	var oldCursor string
	if err := json.Unmarshal(first["cursor"], &oldCursor); err != nil || oldCursor == "" {
		t.Fatalf("initial cursor: %s, %v", first["cursor"], err)
	}
	// Rotate persisted history after the socket has captured its cursor, as a
	// history replacement would. Source resets alone preserve historyEpoch.
	historyEpoch := uuid.NewString()
	if _, err := f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{historyEpoch}',to_jsonb($2::text)) WHERE id=$1`, snapshot.SessionID, historyEpoch); err != nil {
		t.Fatal(err)
	}
	writeEntry := func(seq string) string {
		entryID := uuid.NewString()
		sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: sourceEpoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{
			{SourceSeq: seq, Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, map[string]any{"entryId": entryID, "revision": "1", "kind": "reasoning", "text": "Output in the replacement history"}))},
		}})
		sessionWSKind(t, controller, "events_ack")
		return entryID
	}
	writeEntry("1")
	assertResetAndClosed := func(conn *websocket.Conn) {
		t.Helper()
		frame := sessionWSRead(t, conn)
		if string(frame["type"]) != `"reset_required"` || string(frame["protocol"]) != `"`+sp.Protocol+`"` {
			t.Fatalf("old cursor received history instead of reset: %s", jsonBody(t, frame))
		}
		var reason string
		if json.Unmarshal(frame["reason"], &reason) != nil || reason == "" {
			t.Fatal("history reset omitted its reason")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, data, err := conn.Read(ctx)
		if err == nil || ctx.Err() != nil {
			t.Fatalf("reset must close without further cursor traffic: frame=%s error=%v context=%v", data, err, ctx.Err())
		}
	}
	assertResetAndClosed(browser)
	stale := sessionDial(t, f.server.URL, path+"/channel?after="+oldCursor, f.handler.token, nil)
	assertResetAndClosed(stale)

	recovered := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	frame := sessionWSKind(t, recovered, "snapshot")
	current, err := sp.DecodeSnapshot(frame["snapshot"])
	if err != nil || current.HistoryEpoch != historyEpoch {
		t.Fatalf("replacement snapshot: %+v, %v", current, err)
	}
	var freshCursor string
	if err := json.Unmarshal(frame["cursor"], &freshCursor); err != nil || freshCursor == "" || freshCursor == oldCursor {
		t.Fatalf("replacement cursor: %s, %v", frame["cursor"], err)
	}
	entryID := writeEntry("2")
	frame = sessionWSKind(t, recovered, "event")
	event, err := sp.DecodeEvent(frame["event"])
	if err != nil || event.HistoryEpoch != historyEpoch || event.Kind != "timeline_upsert" {
		t.Fatalf("replacement event: %+v, %v", event, err)
	}
	entry, err := sp.DecodeTimeline(event.Payload)
	if err != nil || entry.EntryID != entryID {
		t.Fatalf("replacement timeline entry: %+v, %v", entry, err)
	}
}

func TestSessionRoutesCookieOriginResetAndShutdown(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID + "/channel"
	secret := "dnst_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(secret))
	if _, err := f.db.Pool.Exec(context.Background(), `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 hour')`, uuid.NewString(), f.handler.principal.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	cookie := "__Host-daynight_session=" + secret
	for _, origin := range []string{"", "https://evil.example", "https://daynight.example.evil"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		header := http.Header{"Cookie": []string{cookie}}
		if origin != "" {
			header.Set("Origin", origin)
		}
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: header})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 403 {
			t.Fatalf("cookie origin %q accepted: %v", origin, err)
		}
	}
	browser := sessionDial(t, f.server.URL, path, "", http.Header{"Cookie": []string{cookie}, "Origin": []string{"https://daynight.example"}})
	sessionWSKind(t, browser, "snapshot")
	reset := sessionDial(t, f.server.URL, path+"?after=invalid", f.handler.token, nil)
	sessionWSKind(t, reset, "reset_required")
	for _, requestPath := range []string{path + "?unknown=1", f.base + "/" + uuid.NewString() + "/channel"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+requestPath, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.handler.token}}})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode < 400 {
			t.Fatalf("bad browser route accepted: %s", requestPath)
		}
	}
	controller, _ := f.controller(t, uuid.NewString())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []*websocket.Conn{browser, controller} {
		read, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _, err := conn.Read(read)
		cancel()
		if err == nil {
			t.Fatal("shutdown retained a websocket")
		}
	}
	if f.application.relay.closing != true {
		t.Fatal("shutdown did not stop upgrades")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	conn, response, err := websocket.Dial(ctx2, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.handler.token}}})
	if conn != nil {
		_ = conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 429 {
		t.Fatal("shutdown accepted a new channel")
	}
}

func TestSessionRoutesControllerRejectsInvalidHandshakesAndFences(t *testing.T) {
	f := sessionHTTPSetup(t)
	for _, input := range []struct {
		path, token, origin string
		status              int
	}{
		{"/api/v1/controller-channel", "", "", 401},
		{"/api/v1/controller-channel", f.handler.token, "", 401},
		{"/api/v1/controller-channel?token=forbidden", f.grant.Token, "", 400},
		{"/api/v1/controller-channel", f.grant.Token, "https://evil.example", 403},
	} {
		request := httptest.NewRequest(http.MethodGet, input.path, nil)
		if input.token != "" {
			request.Header.Set("Authorization", "Bearer "+input.token)
		}
		if input.origin != "" {
			request.Header.Set("Origin", input.origin)
		}
		response := httptest.NewRecorder()
		f.application.ServeHTTP(response, request)
		if response.Code != input.status {
			t.Fatalf("controller rejection: %d %s", response.Code, response.Body)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	response := httptest.NewRecorder()
	f.application.ServeHTTP(response, request)
	if response.Code < 400 {
		t.Fatal("accepted missing websocket upgrade")
	}
	assertClosed := func(conn *websocket.Conn) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _, err := conn.Read(ctx)
		if err == nil || ctx.Err() != nil {
			t.Fatalf("invalid controller not closed promptly: %v", err)
		}
	}
	for _, kind := range []websocket.MessageType{websocket.MessageBinary, websocket.MessageText} {
		conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, kind, []byte(`{}`))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		assertClosed(conn)
	}
	wrongFirst := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	fence := f.snapshot.ControllerFence
	fence.ConnectionEpoch = "1"
	sessionWSWrite(t, wrongFirst, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: fence})
	assertClosed(wrongFirst)
	invalidToken := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	invalidToken.Header.Set("Authorization", "Bearer dncontroller_invalid")
	invalidResponse := httptest.NewRecorder()
	f.application.ServeHTTP(invalidResponse, invalidToken)
	if invalidResponse.Code != http.StatusForbidden {
		t.Fatal("invalid controller grant was not refused before upgrade", invalidResponse.Code)
	}
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "2", Kind: "gap", Payload: json.RawMessage(`{"reason":"Skipped source sequence"}`)}}})
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	stale := snapshot.ControllerFence
	stale.ConnectionEpoch = "999"
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: stale})
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, controller, "heartbeat_ack")
	if err := f.application.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(controller)
	request = httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	response = httptest.NewRecorder()
	f.application.ServeHTTP(response, request)
	if response.Code != 429 {
		t.Fatal("closing controller accepted")
	}
}

func TestSessionRoutesFrameBounds(t *testing.T) {
	if err := relayWrite(context.Background(), nil, make(chan int)); err == nil {
		t.Fatal("serialized unsupported response")
	}
	if err := relayWrite(context.Background(), nil, map[string]any{"body": strings.Repeat("x", sp.MaxFrameBytes)}); err == nil {
		t.Fatal("sent oversized frame")
	}
}

type sessionShutdownHandler struct {
	http.Handler
	shutdown func(context.Context) error
}

func (h sessionShutdownHandler) Shutdown(ctx context.Context) error { return h.shutdown(ctx) }

func TestSessionRuntimeShutsRelayBeforeDependencies(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			config := testConfig(t)
			called := false
			sentinel := errors.New("relay drain failed")
			runtime, err := Start(context.Background(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
				return sessionShutdownHandler{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }), shutdown: func(ctx context.Context) error {
					called = true
					if err := dependencies.Store.Pool.Ping(ctx); err != nil {
						t.Errorf("database closed before relay: %v", err)
					}
					if _, err := dependencies.Files.Put(ctx, uuid.NewString(), "shutdown.txt", strings.NewReader("relay still owns resources")); err != nil {
						t.Errorf("files closed before relay: %v", err)
					}
					if fail {
						return sentinel
					}
					return nil
				}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			err = runtime.Run(ctx)
			if !called {
				t.Fatal("relay shutdown hook not called")
			}
			if fail && !errors.Is(err, sentinel) {
				t.Fatalf("shutdown error lost: %v", err)
			}
			if !fail && err != nil {
				t.Fatal(err)
			}
		})
	}
}
