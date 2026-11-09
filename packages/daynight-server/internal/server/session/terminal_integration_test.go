package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func terminalRequest(h http.Handler, method, path, body, protocol string, plans ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(h, r)
	r.Header.Set("Content-Type", "application/json")
	if len(plans) != 0 {
		r.Header.Set(routePlanHeader, strings.Join(plans, ","))
	}
	if protocol != "" {
		r.Header.Set(v2.ProtocolHeader, protocol)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestTerminalStateReadOnForeignLiveRelayReturnsRoutingError(t *testing.T) {
	f := terminalHTTPSetup(t)
	f.register(t)
	otherApp := newSessionHTTPApplication(t, f.backend, f.authentication, attachmentTestFiles(t))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := otherApp.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	other := *f.h
	other.Handler = httpx.RequestLogging(testLogger(), otherApp)
	for _, item := range []struct{ path, foreign, own string }{{f.base + "/current", "terminal-current-routing", "terminal-current"}, {f.base + "/" + f.message.SessionID + "/state", "terminal-routing", "terminal-state"}} {
		path := item.path
		response := terminalRequest(&other, http.MethodGet, path, "", v2.Protocol, item.foreign)
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"relay_instance_unavailable"`) {
			t.Fatalf("foreign relay state: %d %s", response.Code, response.Body.String())
		}
		response = terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol, item.own)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"connected":true`) {
			t.Fatalf("owning relay state: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestTerminalViewerClosesWhenWorkerConnectionIsReplaced(t *testing.T) {
	f := terminalHTTPSetup(t)
	f.register(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: f.viewerHeaders(f.h), Subprotocols: []string{v2.Protocol}})
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
	ack := f.reconnect(t, m)
	if ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack)
	}
	if _, _, err := browser.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("old viewer followed the replacement Worker connection")
	}
	current := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state")
	if current.Code != http.StatusOK || !strings.Contains(current.Body.String(), `"connectionEpoch":"2"`) || !strings.Contains(current.Body.String(), `"connected":true`) {
		t.Fatal(current.Code, current.Body.String())
	}
}

type terminalHTTPFixture struct {
	sessionHTTPShutdown
	h              *resourceTestHandler
	app            sessionApplication
	backend        *routeBackend
	authentication *routeAuthentication
	state          *terminalFixtureState
	server         *httptest.Server
	base           string
	message        v2.Message
}

func terminalHTTPSetup(t *testing.T) *terminalHTTPFixture {
	t.Helper()
	backend := newRouteBackend(t)
	const origin = "https://daynight.example"
	authentication := newRouteAuthentication(t, origin)
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	h := &resourceTestHandler{token: authentication.Credential(principal), principal: principal, backend: backend, authentication: authentication}
	project, task, claim, worker, worktree := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	pane := "pane_1"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: claim, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: project, TaskID: task, WorkerID: worker, WorktreeID: worktree, OwnerUserID: principal.UserID, ServerOrigin: origin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	f := &terminalHTTPFixture{h: h, backend: backend, authentication: authentication, base: "/api/v1/projects/" + project + "/tasks/" + task + "/sessions", message: m}
	f.configureTerminalBackend(t)
	f.app = newSessionHTTPApplication(t, backend, authentication, attachmentTestFiles(t))
	h.Handler = httpx.RequestLogging(testLogger(), f.app)
	h.application = f.app
	f.server = httptest.NewServer(h.Handler)
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, f.app.Shutdown)
	return f
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
func (f *terminalHTTPFixture) messageRequest(t *testing.T, kind string, payload v2.Payload) v2.Message {
	t.Helper()
	m := f.message
	m.Type = kind
	m.Payload = payload
	profiles := map[string]string{"generation_ledger": "terminal-ledger", "recording_responsibility": "terminal-recording", "recording_evidence": "terminal-evidence", "finalization": "terminal-finalize", "control_state": "terminal-worker-initial", "control_ack": "terminal-ack"}
	profile, ok := profiles[kind]
	if !ok {
		t.Fatalf("no declared terminal HTTP work for %q", kind)
	}
	projection := terminalMessageProjection(t, f.inputSnapshot().(terminalRouteInput), m)
	r := httptest.NewRequest(http.MethodPost, f.base+"/"+m.SessionID+"/worker-messages", strings.NewReader(jsonBody(t, m)))
	authorizeResourceRequest(f.h, r)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	r.Header.Set("Daynight-Connection-Epoch", "1")
	w := f.projectedHTTPRequest(t, r, profile, projection)
	result := terminalMessage(t, w)
	return result
}

func TestTerminalHTTPRegistrationLedgerAndClosedUnavailable(t *testing.T) {
	f := terminalHTTPSetup(t)
	m := f.message
	ack := f.register(t)
	if ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "1" {
		t.Fatal(ack)
	}
	for _, protocol := range []string{"", sp.Protocol} {
		w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", protocol, "terminal-v1-current")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"not_applicable"`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", v2.Protocol, "terminal-current")
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
	readback := terminalRequest(f.h, http.MethodGet, f.base+"/"+m.SessionID+"/recording-evidence/"+evidence.EvidenceID+"?generation=1", "", v2.Protocol, "terminal-evidence-read")
	if readback.Code != 200 || !strings.Contains(readback.Body.String(), evidence.EvidenceID) || !strings.Contains(readback.Body.String(), `"bodyHash"`) {
		t.Fatal(readback.Code, readback.Body.String())
	}
	f.completeTask()
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
	result := terminalMessage(t, terminalRequest(f.h, http.MethodPost, path, jsonBody(t, request), v2.Protocol, "terminal-receipt"))
	if result.Payload.(v2.Receipt).DispositionDigest != digest {
		t.Fatal(result)
	}
	f.selectReceipt(t, receipt, nil)
	f.input(func(in *terminalRouteInput) {
		state := "unavailable"
		in.History = []store.TerminalHistoryRow{{ID: m.SessionID, Claim: m.ClaimID, Backend: "herdr", Created: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Terminal: append([]byte(nil), in.Raw...), State: &state}}
	})
	got := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/receipt", "", v2.Protocol, "terminal-archive-status"))
	if got.Payload.(v2.Receipt).DispositionDigest != digest {
		t.Fatal(got)
	}
	history := terminalRequest(f.h, http.MethodGet, f.base+"?limit=1", "", v2.Protocol, "terminal-history")
	if history.Code != 200 || !strings.Contains(history.Body.String(), m.ClaimID) {
		t.Fatal(history.Code, history.Body.String())
	}
	bad := terminalRequest(f.h, http.MethodGet, f.base+"?limit=0", "", v2.Protocol)
	if bad.Code != 400 {
		t.Fatal(bad.Code, bad.Body.String())
	}
}

func TestTerminalWorkerAndBrowserWebSockets(t *testing.T) {
	f := terminalHTTPSetup(t)
	path := f.base + "/" + f.message.SessionID
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	header := f.workerHeaders()
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	f.handshake(t, worker)
	if worker.Subprotocol() != v2.Protocol {
		t.Fatal("worker selected a different terminal subprotocol")
	}
	reg := f.message.Payload.(v2.Registration)
	viewerHandler := f.addViewer(t, model.ProjectMemberRole)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	ledger := f.message
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	f.workerMessage(t, worker, ledger, "terminal-socket-write")
	viewerHeader := f.viewerHeaders(viewerHandler)
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: viewerHeader, Subprotocols: []string{v2.Protocol}})
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
	f.workerMessage(t, worker, snapshot, "terminal-socket-state")
	update := sessionWSRead(t, browser)
	var observed v2.Snapshot
	if json.Unmarshal(update["snapshot"], &observed) != nil || !reflect.DeepEqual(observed, snapshot.Payload.(v2.Snapshot)) {
		t.Fatal(update)
	}
	f.revokeViewer(viewerHandler.principal)
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "forbidden") }
	revoked := terminalRequest(viewerHandler, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-forbidden")
	failure := decodeResponse[api.ErrorResponse](t, revoked, http.StatusForbidden)
	if failure.Error.Code != "forbidden" || failure.Error.RequestID != revoked.Header().Get("X-Request-ID") {
		t.Fatalf("viewer revocation response: %+v", failure)
	}
	if response := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state"); response.Code != http.StatusOK {
		t.Fatalf("viewer revocation affected the worker owner: %d %s", response.Code, response.Body)
	}
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelClose()
	for i := 0; i < 4; i++ {
		_, _, err = browser.Read(closeCtx)
		if err != nil {
			if closeCtx.Err() != nil {
				t.Fatalf("revoked browser did not close before the deadline: %v", err)
			}
			return
		}
	}
	t.Fatal("revoked browser remained connected")
}

func TestTerminalDuplicateChannelsPreserveOriginalLease(t *testing.T) {
	f := terminalHTTPSetup(t)
	path := f.base + "/" + f.message.SessionID
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dial := func(suffix string, header http.Header) *websocket.Conn {
		t.Helper()
		c, _, err := websocket.Dial(ctx, f.server.URL+path+suffix, &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.CloseNow() })
		return c
	}
	worker := dial("/worker-channel", f.workerHeaders())
	f.handshake(t, worker)
	beforeDuplicate := f.invalidations()
	duplicate := dial("/worker-channel", f.duplicateWorkerHeaders())
	sessionWSWrite(t, duplicate, f.message)
	if _, _, err := duplicate.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("duplicate worker channel accepted")
	}
	f.waitConnections(t, 1)
	if f.invalidations() != beforeDuplicate {
		t.Fatal("duplicate Worker channel revoked the original connection")
	}
	reg := f.message.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	f.messageRequest(t, "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}})
	f.messageRequest(t, "recording_responsibility", v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true})
	f.messageRequest(t, "control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}})
	browserID := uuid.NewString()
	browser := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	sessionWSRead(t, browser)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: browserID}
	message := f.message
	message.Type = "control_request"
	message.Payload = req
	queued := f.submitControl(t, message, browserID)
	if queued.Payload.(v2.OperationResult).State != "queued" {
		t.Fatal(queued)
	}
	f.releaseDispatch(t, req)
	dispatch := sessionWSKind(t, worker, "control_dispatch")
	var payload v2.ControlDispatch
	if err := json.Unmarshal(dispatch["payload"], &payload); err != nil {
		t.Fatal(err)
	}
	f.assertDispatch(t, req, payload)
	lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: reg.Owner.OwnerUserID, BrowserClientID: browserID, ControlEpoch: "2", ExpiresAt: time.Now().Add(29 * time.Second).UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "release_control", "renew_control"}}
	f.messageRequest(t, "control_ack", v2.ControlAck{RequestDigest: payload.RequestDigest, Durable: true, ControlState: state, Result: v2.OperationResult{OperationID: req.OperationID, State: "transport_completed"}})
	beforeViewerQuery, beforeViewerInvalidation := f.viewerQueries(), f.invalidations()
	dupeBrowser := dial("/channel?browserClientId="+browserID, f.duplicateViewerHeaders())
	if _, _, err := dupeBrowser.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("duplicate browser channel accepted")
	}
	f.waitConnections(t, 2)
	if f.viewerQueries() != beforeViewerQuery || f.invalidations() != beforeViewerInvalidation {
		t.Fatal("duplicate browser cleanup changed the original lease")
	}
	got := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state-lease")
	if got.Code != 200 || !strings.Contains(got.Body.String(), lease.LeaseID) {
		t.Fatal(got.Code, got.Body.String())
	}
	op := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/operations/"+req.OperationID, "", v2.Protocol, "terminal-operation-lease"))
	if op.Payload.(v2.OperationResult).State != "transport_completed" {
		t.Fatal(op)
	}
	beforeDisconnect := f.writeIndex()
	f.state.mu.Lock()
	expected := terminalDecodeRecord(t, f.state.input.Raw)
	f.state.mu.Unlock()
	expected.ControlEpoch = "3"
	expected.Control.ControlEpoch = "3"
	terminalSuspend(&expected)
	_ = browser.CloseNow()
	f.awaitSaved(t, beforeDisconnect, func(actual terminalRouteRecord) bool {
		return terminalRecordJSONEqual([]byte(jsonBody(t, actual)), []byte(jsonBody(t, expected)))
	})
	f.waitConnections(t, 1)
	got = terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state")
	if got.Code != http.StatusOK || strings.Contains(got.Body.String(), lease.LeaseID) {
		t.Fatal("original disconnect retained lease", got.Code, got.Body.String())
	}
	replacement := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	sessionWSRead(t, replacement)
}

func terminalArchiveReady(t *testing.T) (*terminalHTTPFixture, string, []byte, v2.Receipt) {
	t.Helper()
	f := terminalHTTPSetup(t)
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
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
	f.register(t)
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
	f.completeTask()
	f.messageRequest(t, "finalization", v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs})
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n \t\n")...)
	path := f.base + "/" + doc.SessionID + "/archive"
	receipt := terminalMessage(t, terminalRequest(f.h, "PUT", path, string(data), v2.Protocol, "terminal-upload-preflight", "terminal-upload")).Payload.(v2.Receipt)
	f.selectReceipt(t, receipt, data)
	return f, path, data, receipt
}

func TestTerminalArchiveDownloadPreservesReceiptBytes(t *testing.T) {
	f, path, data, receipt := terminalArchiveReady(t)
	got := terminalRequest(f.h, "GET", path+"/content", "", v2.Protocol, "terminal-upload-preflight", "terminal-read-content")
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

func TestTerminalArchiveStateHTTPRetainsDeletedOwnerReadback(t *testing.T) {
	f := terminalHTTPSetup(t)
	f.register(t)
	path := f.base + "/" + f.message.SessionID
	initial := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state")
	if initial.Code != http.StatusOK {
		t.Fatal(initial.Code, initial.Body.String())
	}
	var before map[string]any
	if err := json.Unmarshal(initial.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	f.deleteTask()
	response := terminalRequest(f.h, http.MethodGet, path+"/archive/state", "", v2.Protocol, "terminal-archive-state")
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
		plan := "terminal-deleted-task"
		if suffix == "/archive/content" {
			plan = "terminal-upload-preflight"
		}
		if ordinary := terminalRequest(f.h, http.MethodGet, path+suffix, "", v2.Protocol, plan); ordinary.Code != http.StatusNotFound {
			t.Fatal("ordinary deleted session reopened", ordinary.Code, ordinary.Body.String())
		}
	}
	if history := terminalRequest(f.h, http.MethodGet, f.base, "", v2.Protocol, "terminal-deleted-task"); history.Code != http.StatusNotFound {
		t.Fatal(history.Code, history.Body.String())
	}
	for index, suffix := range []string{"/not-a-uuid/archive/state", "/" + uuid.NewString() + "/archive/state"} {
		var plans []string
		if index == 1 {
			plans = []string{"terminal-recovery-read"}
		}
		if result := terminalRequest(f.h, http.MethodGet, f.base+suffix, "", v2.Protocol, plans...); result.Code == http.StatusOK {
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
