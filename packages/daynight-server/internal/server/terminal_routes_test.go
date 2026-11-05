package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func terminalRequest(h http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(h, r)
	r.Header.Set("Content-Type", "application/json")
	if protocol != "" {
		r.Header.Set(v2.ProtocolHeader, protocol)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestTerminalStateReadOnForeignLiveRelayReturnsRoutingError(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	a, err := New(Dependencies{Store: f.app.relay.service.DB, Files: attachmentTestFiles(t)}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	otherApp := a.(*sessionApplication)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := otherApp.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	other := *f.h
	other.Handler = httpx.RequestLogging(testLogger(), otherApp)
	for _, path := range []string{f.base + "/current", f.base + "/" + f.message.SessionID + "/state"} {
		response := terminalRequest(&other, http.MethodGet, path, "", v2.Protocol)
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"relay_instance_unavailable"`) {
			t.Fatalf("foreign relay state: %d %s", response.Code, response.Body.String())
		}
		response = terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"connected":true`) {
			t.Fatalf("owning relay state: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestTerminalViewerClosesWhenWorkerConnectionIsReplaced(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.h.token}}, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	initial := sessionWSRead(t, browser)
	if string(initial["connectionEpoch"]) != `"1"` {
		t.Fatal(initial)
	}
	reg := f.message.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch := "1"
	reg.ConnectionEpoch = &epoch
	m := f.message
	m.Payload = reg
	ack := terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, m), v2.Protocol))
	if ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack)
	}
	if _, _, err := browser.Read(ctx); err == nil {
		t.Fatal("old viewer followed the replacement Worker connection")
	}
	current := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol)
	if current.Code != http.StatusOK || !strings.Contains(current.Body.String(), `"connectionEpoch":"2"`) || !strings.Contains(current.Body.String(), `"connected":true`) {
		t.Fatal(current.Code, current.Body.String())
	}
}

func TestTerminalProtocolSelection(t *testing.T) {
	for _, tc := range []struct {
		header    []string
		protocols string
		want      string
		bad       bool
	}{
		{want: sp.Protocol}, {header: []string{v2.Protocol}, want: v2.Protocol},
		{header: []string{""}, bad: true}, {header: []string{"future"}, bad: true},
		{header: []string{sp.Protocol, v2.Protocol}, bad: true},
		{protocols: v2.Protocol, want: v2.Protocol}, {protocols: "other", bad: true},
		{protocols: sp.Protocol + ", " + v2.Protocol, want: v2.Protocol},
		{header: []string{sp.Protocol}, protocols: v2.Protocol, bad: true},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://example.test/channel", nil)
		if tc.header != nil {
			r.Header[v2.ProtocolHeader] = tc.header
		}
		if tc.protocols != "" {
			r.Header.Set("Sec-WebSocket-Protocol", tc.protocols)
		}
		got, err := selectedSessionProtocol(r)
		if (err != nil) != tc.bad || !tc.bad && got != tc.want {
			t.Fatalf("%+v: %q %v", tc, got, err)
		}
	}
}

func TestTerminalCapabilitiesAreExplicit(t *testing.T) {
	h := projectTestHandler(t, projectTestStore(t), io.Discard)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/session-capabilities", nil)
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	// Use the authenticated fixture identity rather than bypassing authentication.
	authorizeResourceRequest(h, r)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"recordingResponsibilityVersion":1`) || !strings.Contains(w.Body.String(), v2.Protocol) {
		t.Fatal(w.Body.String())
	}
}

type terminalHTTPFixture struct {
	h       *resourceTestHandler
	app     *sessionApplication
	server  *httptest.Server
	base    string
	message v2.Message
}

func terminalHTTPSetup(t *testing.T) terminalHTTPFixture {
	t.Helper()
	db := projectTestStore(t)
	h := projectTestHandler(t, db, io.Discard)
	extendedWorkerTestHandler(h)
	project := taskProject(t, h)
	task := updateHTTPTask(t, h, createHTTPWorkerTask(t, h, project.ID, "Terminal"), map[string]any{"allowAgents": true})
	claim := workerClaimBody(task.Version)
	claim["agentControlMode"] = "herdr"
	task = claimHTTPWorker(t, h, task, claim)
	w := apiWorker(t, task.Properties)
	cfg := configuredTestConfig()
	a, e := New(Dependencies{Store: db, Files: attachmentTestFiles(t)}, cfg, testLogger())
	if e != nil {
		t.Fatal(e)
	}
	app := a.(*sessionApplication)
	h.Handler = httpx.RequestLogging(testLogger(), app)
	server := httptest.NewServer(app)
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := app.Shutdown(ctx); e != nil {
			t.Error(e)
		}
	})
	pane := "pane_1"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: w.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: project.ID, TaskID: task.ID, WorkerID: w.WorkerID, WorktreeID: w.WorktreeID, OwnerUserID: h.principal.UserID, ServerOrigin: cfg.PublicOrigin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	return terminalHTTPFixture{h: h, app: app, server: server, base: taskPath(task) + "/sessions", message: m}
}
func terminalMessage(t *testing.T, w *httptest.ResponseRecorder) v2.Message {
	t.Helper()
	if w.Code != http.StatusOK && w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	m, e := v2.DecodeMessage(w.Body.Bytes())
	if e != nil {
		t.Fatalf("%s: %v", w.Body.String(), e)
	}
	return m
}
func (f terminalHTTPFixture) messageRequest(t *testing.T, kind string, payload v2.Payload) v2.Message {
	t.Helper()
	m := f.message
	m.Type = kind
	m.Payload = payload
	r := httptest.NewRequest(http.MethodPost, f.base+"/"+m.SessionID+"/worker-messages", strings.NewReader(jsonBody(t, m)))
	authorizeResourceRequest(f.h, r)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	r.Header.Set("Daynight-Connection-Epoch", "1")
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return terminalMessage(t, w)
}

func TestTerminalHTTPAutomationRecoveryHasAnIndependentReadbackContract(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx := context.Background()
	reg := f.message.Payload.(v2.Registration)
	native := "original-native"
	reg.Binding.NativeSessionID = &native
	reg.Capabilities = v2.Capabilities{}
	f.message.Payload = reg
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}}})
	f.messageRequest(t, "control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}})
	if err := f.app.relay.service.BindTerminalConnection(ctx, f.h.principal, reg.Owner.ProjectID, reg.Owner.TaskID, f.message.SessionID, f.message.Envelope, "1"); err != nil {
		t.Fatal(err)
	}
	prepare := v2.AutomationRecoveryPrepare{RecoveryID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: uuid.NewString(), Binding: reg.Binding, InitialAssignment: "transport_completed"}
	ack := f.messageRequest(t, "automation_recovery_prepare", prepare)
	path := f.base + "/" + f.message.SessionID + "/automation-recovery/" + prepare.RecoveryID
	read := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol))
	if jsonBody(t, read) != jsonBody(t, ack) {
		t.Fatal("readback changed original preparation")
	}
	for _, probe := range []struct {
		method, path, protocol string
		status                 int
	}{{"GET", path + "?unexpected=1", v2.Protocol, 400}, {"HEAD", path, v2.Protocol, 405}, {"GET", f.base + "/" + f.message.SessionID + "/automation-recovery/" + uuid.NewString(), v2.Protocol, 404}} {
		w := terminalRequest(f.h, probe.method, probe.path, "", probe.protocol)
		if w.Code != probe.status {
			t.Fatal(probe, w.Code, w.Body.String())
		}
	}
	state := terminalRequest(f.h, "GET", f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol)
	if state.Code != 200 || strings.Contains(state.Body.String(), "prepareDigest") {
		t.Fatal("ordinary strict state shape changed", state.Code, state.Body.String())
	}
}
func TestTerminalHTTPRegistrationLedgerAndClosedUnavailable(t *testing.T) {
	f := terminalHTTPSetup(t)
	m := f.message
	ack := terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, m), v2.Protocol))
	if ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "1" {
		t.Fatal(ack)
	}
	for _, protocol := range []string{"", sp.Protocol} {
		w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", protocol)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"not_applicable"`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", v2.Protocol)
	if w.Code != 200 || !strings.Contains(w.Body.String(), m.SessionID) {
		t.Fatal(w.Code, w.Body.String())
	}
	reg := m.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}}
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}})
	responsibility := v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	f.messageRequest(t, "recording_responsibility", responsibility)
	evidence := v2.RecordingEvidence{ResponsibilityID: responsibility.ResponsibilityID, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "0", RegisteredFrameCount: "0", Closed: true, JournalSHA256: v2.HashBytes([]byte("trusted closed journal")), SourceSHA256: v2.EmptySourceDigest()}
	stopped := "2026-01-01T00:00:01Z"
	run.StoppedAt = &stopped
	run.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: run.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}})
	f.messageRequest(t, "recording_evidence", evidence)
	readback := terminalRequest(f.h, http.MethodGet, f.base+"/"+m.SessionID+"/recording-evidence/"+evidence.EvidenceID+"?generation=1", "", v2.Protocol)
	if readback.Code != 200 || !strings.Contains(readback.Body.String(), evidence.EvidenceID) || !strings.Contains(readback.Body.String(), `"bodyHash"`) {
		t.Fatal(readback.Code, readback.Body.String())
	}
	// The fixture has no native process; close only this test task's authority.
	_, e := f.app.relay.service.DB.Pool.Exec(context.Background(), `UPDATE tasks SET status='done' WHERE id=$1`, reg.Owner.TaskID)
	if e != nil {
		t.Fatal(e)
	}
	seal := uuid.NewString()
	f.messageRequest(t, "finalization", v2.Finalization{FinalizationID: seal, ClaimTerminal: true, Runs: []v2.Run{run}})
	reason := "ended_before_first_sample"
	receipt := v2.Receipt{FinalizationID: seal, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}
	request := m
	request.Type = "receipt"
	request.Payload = receipt
	digest, e := v2.ReceiptDigest(request)
	if e != nil {
		t.Fatal(e)
	}
	receipt.DispositionDigest = digest
	request.Payload = receipt
	path := f.base + "/" + m.SessionID + "/archive"
	result := terminalMessage(t, terminalRequest(f.h, http.MethodPost, path, jsonBody(t, request), v2.Protocol))
	if result.Payload.(v2.Receipt).DispositionDigest != digest {
		t.Fatal(result)
	}
	got := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/receipt", "", v2.Protocol))
	if got.Payload.(v2.Receipt).DispositionDigest != digest {
		t.Fatal(got)
	}
	history := terminalRequest(f.h, http.MethodGet, f.base+"?limit=1", "", v2.Protocol)
	if history.Code != 200 || !strings.Contains(history.Body.String(), m.ClaimID) {
		t.Fatal(history.Code, history.Body.String())
	}
	bad := terminalRequest(f.h, http.MethodGet, f.base+"?limit=0", "", v2.Protocol)
	if bad.Code != 400 {
		t.Fatal(bad.Code, bad.Body.String())
	}
}
func TestTerminalHTTPRefusesMalformedAndCrossRouteMessages(t *testing.T) {
	f := terminalHTTPSetup(t)
	for _, protocol := range []string{"future", " "} {
		w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", protocol)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "unsupported_protocol") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, body := range []string{"{}", `{"protocol":"daynight.session.v2","protocol":"daynight.session.v2"}`} {
		w := terminalRequest(f.h, http.MethodPost, f.base, body, v2.Protocol)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	path := f.base + "/" + f.message.SessionID
	w := terminalRequest(f.h, http.MethodGet, path+"/timeline", "", v2.Protocol)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "unsupported_content_kind") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodPost, path+"/worker-messages", jsonBody(t, f.message), v2.Protocol)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodGet, path+"/channel", "", v2.Protocol)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodGet, path+"/archive/receipt", "", v2.Protocol)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestTerminalWorkerAndBrowserWebSockets(t *testing.T) {
	f := terminalHTTPSetup(t)
	path := f.base + "/" + f.message.SessionID
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	header := http.Header{"Authorization": []string{"Bearer " + f.h.token}}
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	sessionWSWrite(t, worker, f.message)
	ack := sessionWSRead(t, worker)
	if string(ack["type"]) != `"registration_ack"` || worker.Subprotocol() != v2.Protocol {
		t.Fatal(ack)
	}
	reg := f.message.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	ledger := f.message
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	sessionWSWrite(t, worker, ledger)
	sessionWSKind(t, worker, "generation_ledger")
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	initial := sessionWSRead(t, browser)
	if string(initial["sessionId"]) != `"`+f.message.SessionID+`"` {
		t.Fatal(initial)
	}
	snapshot := f.message
	snapshot.Type = "snapshot"
	snapshot.Payload = v2.Snapshot{ConnectionEpoch: "1", SegmentID: run.SegmentIDs[0], SegmentOrdinal: "1", Binding: run.Binding, Frame: v2.Frame{FrameSeq: "1", CapturedAt: "2026-01-01T00:00:00Z", ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{}}}}
	sessionWSWrite(t, worker, snapshot)
	sessionWSRead(t, worker)
	update := sessionWSRead(t, browser)
	if string(update["snapshot"]) == "null" {
		t.Fatal(update)
	}
	// Revoking membership closes the existing browser subscription.
	_, err = f.app.relay.service.DB.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, reg.Owner.ProjectID, reg.Owner.OwnerUserID)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		_, _, err = browser.Read(ctx)
		if err != nil {
			return
		}
	}
	t.Fatal("revoked browser remained connected")
}

func terminalInitialInputChannel(t *testing.T) (terminalHTTPFixture, *websocket.Conn) {
	t.Helper()
	f := terminalHTTPSetup(t)
	reg := f.message.Payload.(v2.Registration)
	reg.Capabilities = v2.Capabilities{}
	f.message.Payload = reg
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.h.token}}, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.CloseNow() })
	sessionWSWrite(t, worker, f.message)
	sessionWSKind(t, worker, "registration_ack")
	ledger := f.message
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}}}
	sessionWSWrite(t, worker, ledger)
	sessionWSKind(t, worker, "generation_ledger")
	return f, worker
}

func TestTerminalWorkerChannelRetainsDefinitelyUnsentInitialRetry(t *testing.T) {
	f, worker := terminalInitialInputChannel(t)
	// These are Worker observations of one initial assignment. A rejected
	// zero-write attempt returns to pending before a new admitted attempt starts.
	for index, initial := range []string{"pending", "dispatching", "pending", "dispatching", "transport_completed"} {
		message := f.message
		message.Type = "control_state"
		message.Payload = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: initial, AvailableActions: []string{"acquire_control"}}
		sessionWSWrite(t, worker, message)
		ack := sessionWSKind(t, worker, "control_state")
		var control v2.ControlState
		if err := json.Unmarshal(ack["payload"], &control); err != nil {
			t.Fatal(err)
		}
		if control.InitialAssignment != initial || control.State != "automation" || control.ConnectionEpoch != "1" || control.ControlEpoch != "1" {
			t.Fatalf("initial observation %d was not acknowledged on the original channel: %+v", index, control)
		}
	}
	response := terminalRequest(f.h, http.MethodGet, f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol)
	var state struct {
		Connected bool            `json:"connected"`
		Control   v2.ControlState `json:"control"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || !state.Connected || state.Control.InitialAssignment != "transport_completed" {
		t.Fatal("initial retry closed the Worker channel or lost its durable result", response.Code, response.Body.String())
	}
}

func TestTerminalWorkerChannelRejectsInitialReplayAfterUncertainOrFinalResult(t *testing.T) {
	for _, initial := range []string{"unknown", "unconfirmed", "transport_completed"} {
		t.Run(initial, func(t *testing.T) {
			f, worker := terminalInitialInputChannel(t)
			message := f.message
			message.Type = "control_state"
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: initial, AvailableActions: []string{}}
			message.Payload = state
			sessionWSWrite(t, worker, message)
			sessionWSKind(t, worker, "control_state")
			state.InitialAssignment = "pending"
			message.Payload = state
			sessionWSWrite(t, worker, message)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, _, err := worker.Read(ctx); err == nil || ctx.Err() != nil {
				t.Fatalf("Worker channel did not reject %s to pending: %v", initial, err)
			}
			response := terminalRequest(f.h, http.MethodGet, f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol)
			var observed struct {
				Control v2.ControlState `json:"control"`
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &observed) != nil || observed.Control.InitialAssignment != initial {
				t.Fatal("rejected replay replaced the original initial result", response.Code, response.Body.String())
			}
		})
	}
}

func TestTerminalDuplicateChannelsPreserveOriginalLease(t *testing.T) {
	f := terminalHTTPSetup(t)
	path := f.base + "/" + f.message.SessionID
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	header := http.Header{"Authorization": []string{"Bearer " + f.h.token}}
	dial := func(suffix string) *websocket.Conn {
		t.Helper()
		c, _, err := websocket.Dial(ctx, f.server.URL+path+suffix, &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.CloseNow() })
		return c
	}
	worker := dial("/worker-channel")
	sessionWSWrite(t, worker, f.message)
	sessionWSKind(t, worker, "registration_ack")
	duplicate := dial("/worker-channel")
	sessionWSWrite(t, duplicate, f.message)
	if _, _, err := duplicate.Read(ctx); err == nil {
		t.Fatal("duplicate worker channel accepted")
	}
	reg := f.message.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}})
	f.messageRequest(t, "recording_responsibility", v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true})
	f.messageRequest(t, "control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}})
	browserID := uuid.NewString()
	browser := dial("/channel?browserClientId=" + browserID)
	sessionWSRead(t, browser)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: browserID}
	message := f.message
	message.Type = "control_request"
	message.Payload = req
	r := httptest.NewRequest(http.MethodPost, path+"/commands", strings.NewReader(jsonBody(t, message)))
	authorizeResourceRequest(f.h, r)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	r.Header.Set("Daynight-Browser-Client", browserID)
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	if terminalMessage(t, w).Payload.(v2.OperationResult).State != "queued" {
		t.Fatal(w.Body.String())
	}
	dispatch := sessionWSKind(t, worker, "control_dispatch")
	var payload v2.ControlDispatch
	if err := json.Unmarshal(dispatch["payload"], &payload); err != nil {
		t.Fatal(err)
	}
	lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: reg.Owner.OwnerUserID, BrowserClientID: browserID, ControlEpoch: "2", ExpiresAt: time.Now().Add(29 * time.Second).UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "release_control", "renew_control"}}
	f.messageRequest(t, "control_ack", v2.ControlAck{RequestDigest: payload.RequestDigest, Durable: true, ControlState: state, Result: v2.OperationResult{OperationID: req.OperationID, State: "transport_completed"}})
	dupeBrowser := dial("/channel?browserClientId=" + browserID)
	if _, _, err := dupeBrowser.Read(ctx); err == nil {
		t.Fatal("duplicate browser channel accepted")
	}
	got := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol)
	if got.Code != 200 || !strings.Contains(got.Body.String(), lease.LeaseID) {
		t.Fatal(got.Code, got.Body.String())
	}
	op := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/operations/"+req.OperationID, "", v2.Protocol))
	if op.Payload.(v2.OperationResult).State != "transport_completed" {
		t.Fatal(op)
	}
	// An actual original disconnect releases the lease and frees the browser key.
	_ = browser.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got = terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol)
		if !strings.Contains(got.Body.String(), lease.LeaseID) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("original disconnect retained lease")
		}
		time.Sleep(10 * time.Millisecond)
	}
	replacement := dial("/channel?browserClientId=" + browserID)
	sessionWSRead(t, replacement)
}

func TestTerminalHTTPBoundaryAndReadbackErrors(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	path := f.base + "/" + f.message.SessionID
	for _, tc := range []struct {
		method, suffix, body, protocol string
		code                           int
	}{
		{"GET", "/state", "", v2.Protocol, 200},
		{"GET", "/archive/state", "", v2.Protocol, 200},
		{"GET", "/archive/state", "", "", 400},
		{"GET", "/archive/state", "", sp.Protocol, 400},
		{"GET", "/archive/state", "", "future", 400},
		{"GET", "/archive/state?extra=1", "", v2.Protocol, 400},
		{"GET", "/archive/state?generation=1&generation=2", "", v2.Protocol, 400},
		{"HEAD", "/archive/state", "", v2.Protocol, 405},
		{"POST", "/archive/state", "{}", v2.Protocol, 405},
		{"DELETE", "/archive/state", "", v2.Protocol, 405},
		{"GET", "/state", "", "", 400},
		{"HEAD", "/state", "", v2.Protocol, 405},
		{"DELETE", "/state", "", v2.Protocol, 405},
		{"HEAD", "/worker-messages", "", v2.Protocol, 405},
		{"GET", "/archive", "", v2.Protocol, 200},
		{"GET", "/archive/content", "", v2.Protocol, 409},
		{"PUT", "/archive", "{}", v2.Protocol, 409},
		{"GET", "/recording-evidence/" + uuid.NewString() + "?generation=1", "", v2.Protocol, 404},
		{"GET", "/recording-evidence/" + uuid.NewString() + "?extra=1", "", v2.Protocol, 400},
		{"GET", "/state?extra=1", "", v2.Protocol, 400},
		{"GET", "/operations/" + uuid.NewString(), "", v2.Protocol, 404},
		{"POST", "/commands", jsonBody(t, f.message), v2.Protocol, 400},
		{"POST", "/worker-messages?extra=1", jsonBody(t, f.message), v2.Protocol, 400},
		{"GET", "/worker-channel?extra=1", "", v2.Protocol, 400},
		{"GET", "/worker-channel", "", v2.Protocol, 400},
		{"GET", "/channel?extra=1", "", v2.Protocol, 400},
	} {
		t.Run(tc.method+tc.suffix+tc.protocol, func(t *testing.T) {
			w := terminalRequest(f.h, tc.method, path+tc.suffix, tc.body, tc.protocol)
			if w.Code != tc.code {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	for _, query := range []string{"?limit=no", "?extra=1"} {
		w := terminalRequest(f.h, "GET", f.base+query, "", v2.Protocol)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, contentType := range []string{"text/plain", "application/json; charset=latin1"} {
		r := httptest.NewRequest("POST", f.base, strings.NewReader(jsonBody(t, f.message)))
		authorizeResourceRequest(f.h, r)
		r.Header.Set(v2.ProtocolHeader, v2.Protocol)
		r.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	other := f.message
	other.SessionID = uuid.NewString()
	w := terminalRequest(f.h, "POST", path+"/worker-messages", jsonBody(t, other), v2.Protocol)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, epoch := range []string{"0", "01", "no"} {
		r := httptest.NewRequest("POST", path+"/worker-messages", strings.NewReader(jsonBody(t, f.message)))
		authorizeResourceRequest(f.h, r)
		r.Header.Set(v2.ProtocolHeader, v2.Protocol)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Daynight-Connection-Epoch", epoch)
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestTerminalWorkerChannelRejectsBinaryRegistration(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.h.token}}, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(ctx, websocket.MessageBinary, []byte(jsonBody(t, f.message))); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.Read(ctx); err == nil {
		t.Fatal("binary registration accepted")
	}
}

func TestTerminalArchiveDownloadPreservesReceiptBytes(t *testing.T) {
	f := terminalHTTPSetup(t)
	raw, err := os.ReadFile("../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	reg := f.message.Payload.(v2.Registration)
	reg.Binding = doc.Runs[0].Binding
	f.message.Payload = reg
	doc.SessionID = f.message.SessionID
	doc.ClaimID = f.message.ClaimID
	doc.Owner = reg.Owner
	doc.FinalizationID = uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = reg.Owner
	}
	terminalMessage(t, terminalRequest(f.h, "POST", f.base, jsonBody(t, f.message), v2.Protocol))
	active := doc.Runs[0]
	active.StopProof = nil
	active.StoppedAt = nil
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{active}})
	responsibility := v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	f.messageRequest(t, "recording_responsibility", responsibility)
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: doc.Runs})
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	f.messageRequest(t, "recording_evidence", v2.RecordingEvidence{ResponsibilityID: responsibility.ResponsibilityID, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "1", RegisteredFrameCount: "1", Closed: true, JournalSHA256: v2.HashBytes([]byte("durable test journal")), SourceSHA256: digest})
	if _, err = f.app.relay.service.DB.Pool.Exec(context.Background(), `UPDATE tasks SET status='done' WHERE id=$1`, reg.Owner.TaskID); err != nil {
		t.Fatal(err)
	}
	f.messageRequest(t, "finalization", v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs})
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n \t\n")...)
	path := f.base + "/" + doc.SessionID + "/archive"
	receipt := terminalMessage(t, terminalRequest(f.h, "PUT", path, string(data), v2.Protocol)).Payload.(v2.Receipt)
	got := terminalRequest(f.h, "GET", path+"/content", "", v2.Protocol)
	if got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	if !bytes.Equal(got.Body.Bytes(), data) {
		t.Fatalf("archive bytes changed: uploaded %d bytes, downloaded %d", len(data), got.Body.Len())
	}
	if receipt.SHA256 == nil || *receipt.SHA256 != v2.HashBytes(got.Body.Bytes()) || receipt.ByteLength == nil || *receipt.ByteLength != strconv.Itoa(got.Body.Len()) {
		t.Fatal("download differs from immutable receipt", receipt)
	}
	if got.Header().Get("Content-Type") != "application/json" {
		t.Fatal(got.Header())
	}
}

func TestTerminalWorkerChannelAdvancesStoppedGeneration(t *testing.T) {
	testTerminalWorkerChannelAdvancesStoppedGeneration(t, false)
}

func TestTerminalWorkerChannelRecoversNativeIdentityLearnedAtStop(t *testing.T) {
	testTerminalWorkerChannelAdvancesStoppedGeneration(t, true)
}

func testTerminalWorkerChannelAdvancesStoppedGeneration(t *testing.T, learnedAtStop bool) {
	t.Helper()
	f := terminalHTTPSetup(t)
	native := "native-conversation"
	reg := f.message.Payload.(v2.Registration)
	if !learnedAtStop {
		reg.Binding.NativeSessionID = &native
	}
	f.message.Payload = reg
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.h.token}}, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	sessionWSWrite(t, worker, f.message)
	sessionWSKind(t, worker, "registration_ack")
	send := func(generation, kind string, payload v2.Payload) map[string]json.RawMessage {
		t.Helper()
		m := f.message
		m.ExecutionGeneration = generation
		m.Type = kind
		m.Payload = payload
		sessionWSWrite(t, worker, m)
		return sessionWSKind(t, worker, kind)
	}
	first := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	send("1", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first}})
	stopped := "2026-01-01T00:00:01Z"
	first.StoppedAt = &stopped
	first.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: first.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	first.StopProof.Binding.NativeSessionID = &native
	send("1", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first}})
	next := v2.Run{ExecutionGeneration: "2", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:02Z", SegmentIDs: []string{uuid.NewString()}}
	next.Binding.TerminalID = "term_recovered"
	next.Binding.NativeSessionID = &native
	ack := send("2", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first, next}})
	if string(ack["executionGeneration"]) != `"2"` {
		t.Fatal(ack)
	}
	waitConnected := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			w := terminalRequest(f.h, "GET", path+"/state", "", v2.Protocol)
			var state struct {
				Connected bool `json:"connected"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil {
				t.Fatal(w.Code, w.Body.String())
			}
			if state.Connected == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("connected=%t after generation transition, want %t", state.Connected, want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	// Polling must use the newly committed generation, not the handshake fence.
	waitConnected(true)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: next.SegmentIDs[0], SegmentOrdinal: "2", Binding: next.Binding, Frame: v2.Frame{FrameSeq: "1", CapturedAt: "2026-01-01T00:00:02Z", ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{}}}}
	send("2", "snapshot", snapshot)
	// Other message types cannot use the old generation after the ledger grant.
	stale := f.message
	stale.Type = "snapshot"
	stale.Payload = snapshot
	sessionWSWrite(t, worker, stale)
	if _, _, err = worker.Read(ctx); err == nil {
		t.Fatal("old-generation snapshot accepted")
	}
	// Cleanup must also use the current generation to revoke this connection.
	waitConnected(false)
}

func TestTerminalArchiveStateHTTPRetainsDeletedOwnerReadback(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	path := f.base + "/" + f.message.SessionID
	initial := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol)
	if initial.Code != http.StatusOK {
		t.Fatal(initial.Code, initial.Body.String())
	}
	var before map[string]any
	if err := json.Unmarshal(initial.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	owner := f.message.Payload.(v2.Registration).Owner
	if _, err := f.app.relay.service.DB.Pool.Exec(context.Background(), `UPDATE tasks SET status='done',deleted_at=now() WHERE id=$1`, owner.TaskID); err != nil {
		t.Fatal(err)
	}
	response := terminalRequest(f.h, http.MethodGet, path+"/archive/state", "", v2.Protocol)
	if response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	var after map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) || after["connected"] != false {
		t.Fatal(after)
	}
	for _, key := range []string{"protocol", "schemaVersion", "projectionVersion", "sessionId", "claimId", "executionGeneration", "owner", "binding", "ledger", "recording", "archive"} {
		if jsonBody(t, before[key]) != jsonBody(t, after[key]) {
			t.Fatalf("%s changed: %#v != %#v", key, before[key], after[key])
		}
	}
	for _, suffix := range []string{"/state", "/archive/content"} {
		if ordinary := terminalRequest(f.h, http.MethodGet, path+suffix, "", v2.Protocol); ordinary.Code != http.StatusNotFound {
			t.Fatal("ordinary deleted session reopened", ordinary.Code, ordinary.Body.String())
		}
	}
	if history := terminalRequest(f.h, http.MethodGet, f.base, "", v2.Protocol); history.Code != http.StatusNotFound {
		t.Fatal(history.Code, history.Body.String())
	}
	for _, suffix := range []string{"/not-a-uuid/archive/state", "/" + uuid.NewString() + "/archive/state"} {
		if result := terminalRequest(f.h, http.MethodGet, f.base+suffix, "", v2.Protocol); result.Code == http.StatusOK {
			t.Fatal("invalid or foreign session accepted")
		}
	}
	request := httptest.NewRequest(http.MethodGet, path+"/archive/state", nil)
	authorizeResourceRequest(f.h, request)
	request.Header[v2.ProtocolHeader] = []string{v2.Protocol, v2.Protocol}
	recorder := httptest.NewRecorder()
	f.h.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
}
