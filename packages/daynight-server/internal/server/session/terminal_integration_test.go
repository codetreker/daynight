package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func terminalAwait(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(message)
	}
}

func terminalReleaseContext(t *testing.T, ctx context.Context) {
	t.Helper()
	deadline, ok := ctx.Deadline()
	if !ok || ctx.Err() != nil || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
		t.Error("terminal release did not receive a live, bounded cleanup context")
	}
}

func terminalCaller(t *testing.T, f *terminalHTTPFixture, ctx context.Context, principal, expected model.Principal, project, task, id string) {
	t.Helper()
	owner := f.message.Payload.(v2.Registration).Owner
	if ctx.Err() != nil || principal != expected || project != owner.ProjectID || task != owner.TaskID || id != f.message.SessionID {
		t.Errorf("terminal call changed principal, IDs or context: %v %v %s/%s/%s", ctx.Err(), principal, project, task, id)
	}
}

func TestTerminalStateReadOnForeignLiveRelayReturnsRoutingError(t *testing.T) {
	f := terminalHTTPSetup(t)
	var currentCalls, stateCalls atomic.Int32
	routing := &model.Fault{Code: "relay_instance_unavailable", Message: "The live terminal belongs to another relay."}
	f.calls.ExpectCalls("CurrentTerminal", 2)
	f.calls.ExpectCalls("TerminalState", 2)
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.CurrentTerminal = func(ctx context.Context, p model.Principal, project, task string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			if currentCalls.Add(1) == 1 {
				return nil, routing
			}
			return f.knownState("1"), nil
		}
		calls.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			if stateCalls.Add(1) == 1 {
				return nil, routing
			}
			return f.knownState("1"), nil
		}
	})
	for _, path := range []string{f.base + "/current", f.base + "/" + f.message.SessionID + "/state"} {
		response := terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol)
		assertProjectError(t, response, http.StatusServiceUnavailable, routing.Code)
		response = terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"connected":true`) {
			t.Fatalf("provided owner state: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestTerminalViewerClosesWhenWorkerConnectionIsReplaced(t *testing.T) {
	f := terminalHTTPSetup(t)
	browserID := uuid.NewString()
	replace, released := make(chan struct{}), make(chan struct{})
	var states atomic.Int32
	f.calls.ExpectCalls("TerminalState", 2)
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			if states.Add(1) == 1 {
				return f.knownState("1"), nil
			}
			select {
			case <-replace:
				return f.knownState("2"), nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		calls.DisconnectTerminalViewer = func(ctx context.Context, p model.Principal, project, task, id, browser, claim, epoch string) error {
			f.scope(t, ctx, p, project, task, id)
			terminalReleaseContext(t, ctx)
			if browser != browserID || claim != f.message.ClaimID || epoch != "1" {
				t.Error("replacement cleanup lost its admitted identity")
			}
			close(released)
			return nil
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/channel?browserClientId="+browserID, &websocket.DialOptions{HTTPHeader: f.viewerHeaders(f.h), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if initial := sessionWSRead(t, conn); string(initial["connectionEpoch"]) != `"1"` {
		t.Fatal(initial)
	}
	close(replace)
	if _, _, err = conn.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("old viewer followed the supplied replacement connection")
	}
	terminalAwait(t, released, "replacement viewer did not release its admitted identity")
	f.waitConnections(t, 0)
}

func TestTerminalHTTPDispatchesMessagesAndProvidedReadbacks(t *testing.T) {
	f := terminalHTTPSetup(t)
	f.register(t)
	registration := f.message.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}}
	ledger := f.message
	ledger.Type, ledger.Payload = "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}}
	responsibility := f.message
	responsibility.Type, responsibility.Payload = "recording_responsibility", v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	evidence := f.message
	evidenceID := uuid.NewString()
	evidence.Type, evidence.Payload = "recording_evidence", v2.RecordingEvidence{ResponsibilityID: responsibility.Payload.(v2.RecordingResponsibility).ResponsibilityID, EvidenceID: evidenceID, Revision: "1", SelectedFrameCount: "0", RegisteredFrameCount: "0", Closed: true, JournalSHA256: v2.HashBytes([]byte("closed journal")), SourceSHA256: v2.EmptySourceDigest()}
	reason := "ended_before_first_sample"
	receipt := f.message
	receipt.Type, receipt.Payload = "receipt", v2.Receipt{FinalizationID: uuid.NewString(), Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}
	digest, err := v2.ReceiptDigest(receipt)
	if err != nil {
		t.Fatal(err)
	}
	value := receipt.Payload.(v2.Receipt)
	value.DispositionDigest = digest
	receipt.Payload = value
	stoppedAt := "2026-01-01T00:00:01Z"
	stoppedRun := run
	stoppedRun.StoppedAt = &stoppedAt
	stoppedRun.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: run.Binding, BootID: "boot", StoppedAt: stoppedAt, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	finalization := f.message
	finalization.Type, finalization.Payload = "finalization", v2.Finalization{FinalizationID: value.FinalizationID, ClaimTerminal: true, Runs: []v2.Run{stoppedRun}}
	browserID := uuid.NewString()
	command := f.message
	operationID := uuid.NewString()
	command.Type, command.Payload = "control_request", v2.ControlRequest{OperationID: operationID, ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: browserID}
	queued := f.message
	queued.Type, queued.Payload = "operation_result", v2.OperationResult{OperationID: operationID, State: "queued"}
	var recordingCalls, historyCalls atomic.Int32
	f.calls.ExpectCalls("Current", 2)
	f.calls.ExpectCalls("UpdateTerminalRecording", 2)
	f.calls.ExpectCalls("TerminalHistory", 2)
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Current = func(ctx context.Context, p model.Principal, project, task string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			return map[string]any{"status": "not_applicable", "protocol": sp.Protocol}, nil
		}
		calls.CurrentTerminal = func(ctx context.Context, p model.Principal, project, task string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			return f.knownState("1"), nil
		}
		calls.UpdateTerminalLedger = func(ctx context.Context, p model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if epoch != "1" || !reflect.DeepEqual(message, ledger) {
				t.Error("ledger handler changed the parsed message or epoch")
			}
			return ledger, nil
		}
		calls.UpdateTerminalRecording = func(ctx context.Context, p model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			expected := responsibility
			if recordingCalls.Add(1) == 2 {
				expected = evidence
			}
			if epoch != "1" || !reflect.DeepEqual(message, expected) {
				t.Error("recording handler changed its selected responsibility/evidence message")
			}
			return expected, nil
		}
		calls.TerminalRecordingEvidence = func(ctx context.Context, p model.Principal, project, task, id, generation, requested string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			if generation != "1" || requested != evidenceID {
				t.Error("evidence query changed generation or identity")
			}
			return map[string]any{"evidence": evidence.Payload, "bodyHash": v2.HashBytes([]byte("provided evidence"))}, nil
		}
		calls.UpdateTerminalArchive = func(ctx context.Context, p model.Principal, project, task, id string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if !reflect.DeepEqual(message, receipt) {
				t.Error("receipt handler changed its parsed message")
			}
			return receipt, nil
		}
		calls.TerminalReceipt = func(ctx context.Context, p model.Principal, project, task, id string) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			return receipt, nil
		}
		calls.FinalizeTerminal = func(ctx context.Context, p model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if epoch != "1" || !reflect.DeepEqual(message, finalization) {
				t.Error("finalization handler changed its selected message or epoch")
			}
			return finalization, nil
		}
		calls.SubmitTerminal = func(ctx context.Context, p model.Principal, project, task, id, browser string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if browser != browserID || !reflect.DeepEqual(message, command) {
				t.Error("command handler changed browser header or parsed intent")
			}
			return queued, nil
		}
		calls.TerminalOperation = func(ctx context.Context, p model.Principal, project, task, id, requestedOperation string) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if requestedOperation != operationID {
				t.Error("operation readback changed the route identity")
			}
			return queued, nil
		}
		calls.TerminalHistory = func(ctx context.Context, p model.Principal, project, task, cursor string, limit int) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			if cursor != "" {
				t.Error("history request introduced a cursor")
			}
			if historyCalls.Add(1) == 2 {
				if limit != 0 {
					t.Error("history request changed the supplied zero limit")
				}
				return nil, &model.Fault{Code: "invalid_input", Message: "History limit is outside the supported range."}
			}
			if limit != 1 {
				t.Error("history request changed the supplied limit")
			}
			return map[string]any{"items": []any{map[string]any{"sessionId": f.message.SessionID, "claimId": f.message.ClaimID, "archive": value}}, "nextCursor": nil}, nil
		}
	})
	for _, protocol := range []string{"", sp.Protocol} {
		response := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", protocol)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"not_applicable"`) {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if response := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", v2.Protocol); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), f.message.SessionID) {
		t.Fatal(response.Code, response.Body.String())
	}
	for _, message := range []v2.Message{ledger, responsibility, evidence, finalization} {
		request := httptest.NewRequest(http.MethodPost, f.base+"/"+f.message.SessionID+"/worker-messages", strings.NewReader(jsonBody(t, message)))
		authorizeResourceRequest(f.h, request)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(v2.ProtocolHeader, v2.Protocol)
		request.Header.Set("Daynight-Connection-Epoch", "1")
		response := httptest.NewRecorder()
		f.h.ServeHTTP(response, request)
		if actual := terminalMessage(t, response); !reflect.DeepEqual(actual, message) {
			t.Fatal("HTTP response changed the supplied result", actual)
		}
	}
	path := f.base + "/" + f.message.SessionID
	commandRequest := httptest.NewRequest(http.MethodPost, path+"/commands", strings.NewReader(jsonBody(t, command)))
	authorizeResourceRequest(f.h, commandRequest)
	commandRequest.Header.Set("Content-Type", "application/json")
	commandRequest.Header.Set(v2.ProtocolHeader, v2.Protocol)
	commandRequest.Header.Set("Daynight-Browser-Client", browserID)
	commandResponse := httptest.NewRecorder()
	f.h.ServeHTTP(commandResponse, commandRequest)
	if commandResponse.Code != http.StatusAccepted || !reflect.DeepEqual(terminalMessage(t, commandResponse), queued) {
		t.Fatal("command response changed service result or accepted status", commandResponse.Code, commandResponse.Body.String())
	}
	if result := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/operations/"+operationID, "", v2.Protocol)); !reflect.DeepEqual(result, queued) {
		t.Fatal("operation readback changed the supplied result", result)
	}
	if response := terminalRequest(f.h, http.MethodGet, path+"/recording-evidence/"+evidenceID+"?generation=1", "", v2.Protocol); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), evidenceID) {
		t.Fatal(response.Code, response.Body.String())
	}
	if actual := terminalMessage(t, terminalRequest(f.h, http.MethodPost, path+"/archive", jsonBody(t, receipt), v2.Protocol)); !reflect.DeepEqual(actual, receipt) {
		t.Fatal(actual)
	}
	if actual := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path+"/archive/receipt", "", v2.Protocol)); !reflect.DeepEqual(actual, receipt) {
		t.Fatal(actual)
	}
	if response := terminalRequest(f.h, http.MethodGet, f.base+"?limit=1", "", v2.Protocol); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), f.message.ClaimID) {
		t.Fatal(response.Code, response.Body.String())
	}
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, f.base+"?limit=0", "", v2.Protocol), http.StatusBadRequest, "invalid_input")
}

func TestTerminalWorkerAndBrowserWebSockets(t *testing.T) {
	f := terminalHTTPSetup(t)
	viewer := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	viewerBrowserID := uuid.NewString()
	viewerHandler := &resourceTestHandler{Handler: f.h.Handler, principal: viewer, token: f.authentication.Credential(viewer)}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	registration := f.message.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	ledger := f.message
	ledger.Type, ledger.Payload = "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run}}
	snapshot := f.message
	snapshot.Type, snapshot.Payload = "snapshot", v2.Snapshot{ConnectionEpoch: "1", SegmentID: run.SegmentIDs[0], SegmentOrdinal: "1", Binding: run.Binding, Frame: v2.Frame{FrameSeq: "1", CapturedAt: "2026-01-01T00:00:00Z", ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "terminal screen"}}}}}
	request := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: viewerBrowserID}
	requestDigest, err := v2.ControlRequestDigest(f.h.principal.UserID, request)
	if err != nil {
		t.Fatal(err)
	}
	offer := f.message
	offer.Type, offer.Payload = "control_dispatch", v2.ControlDispatch{ActorUserID: f.h.principal.UserID, RequestDigest: requestDigest, Request: request}
	offerReady := make(chan struct{})
	var offerSent atomic.Bool
	snapshotSeen, revoke, revokePoll, workerReleased, viewerReleased := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var revokeOnce sync.Once
	t.Cleanup(func() { revokeOnce.Do(func() { close(revoke) }) })
	var viewerStates atomic.Int32
	f.calls.RequireCalls("PollTerminal", 1)
	f.calls.ExpectCalls("TerminalState", 5)
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.RegisterTerminal = func(call context.Context, p model.Principal, project, task string, message v2.Message) (v2.Message, error) {
			f.scope(t, call, p, project, task, message.SessionID)
			if !reflect.DeepEqual(message, f.message) {
				t.Error("worker registration text changed")
			}
			return f.ack("1"), nil
		}
		calls.BindTerminalConnection = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, call, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("worker bind changed the admitted fence")
			}
			return nil
		}
		calls.UpdateTerminalLedger = func(call context.Context, p model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
			f.scope(t, call, p, project, task, id)
			if epoch != "1" || !reflect.DeepEqual(message, ledger) {
				t.Error("worker ledger text changed")
			}
			return ledger, nil
		}
		calls.HandleTerminalControl = func(call context.Context, p model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
			f.scope(t, call, p, project, task, id)
			if epoch != "1" || !reflect.DeepEqual(message, snapshot) {
				t.Error("worker snapshot text changed")
			}
			close(snapshotSeen)
			return snapshot, nil
		}
		calls.PollTerminal = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
			if err := call.Err(); err != nil {
				return nil, err
			}
			f.scope(t, call, p, project, task, id)
			if fence.SessionID != f.message.SessionID || fence.ClaimID != f.message.ClaimID || fence.ExecutionGeneration != "1" || epoch != "1" {
				t.Error("worker poll changed the granted identity")
			}
			select {
			case <-offerReady:
				if offerSent.CompareAndSwap(false, true) {
					return []v2.Message{offer}, nil
				}
			default:
			}
			return []v2.Message{}, nil
		}
		calls.TerminalState = func(call context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			if p == f.h.principal {
				f.scope(t, call, p, project, task, id)
				return f.knownState("1"), nil
			}
			terminalCaller(t, f, call, p, viewer, project, task, id)
			switch viewerStates.Add(1) {
			case 1:
				return f.knownState("1"), nil
			case 2:
				select {
				case <-snapshotSeen:
				case <-call.Done():
					return nil, call.Err()
				}
				state := f.knownState("1")
				state["snapshot"] = snapshot.Payload
				return state, nil
			case 3:
				close(revokePoll)
				select {
				case <-revoke:
				case <-call.Done():
					return nil, call.Err()
				}
			}
			return nil, &model.Fault{Code: "forbidden", Message: "Viewer access was revoked."}
		}
		calls.DisconnectTerminal = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, call, p, project, task, id)
			terminalReleaseContext(t, call)
			if fence != ledger.Envelope || epoch != "1" {
				t.Error("worker cleanup changed the last granted fence")
			}
			close(workerReleased)
			return nil
		}
		calls.DisconnectTerminalViewer = func(call context.Context, p model.Principal, project, task, id, browser, claim, epoch string) error {
			terminalCaller(t, f, call, p, viewer, project, task, id)
			terminalReleaseContext(t, call)
			if browser != viewerBrowserID || claim != f.message.ClaimID || epoch != "1" {
				t.Error("viewer cleanup changed its admitted identity")
			}
			close(viewerReleased)
			return nil
		}
	})
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders(), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	f.handshake(t, worker)
	if worker.Subprotocol() != v2.Protocol {
		t.Fatal("worker negotiated a different protocol")
	}
	f.workerMessage(t, worker, ledger)
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+viewerBrowserID, &websocket.DialOptions{HTTPHeader: f.viewerHeaders(viewerHandler), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	if initial := sessionWSRead(t, browser); string(initial["sessionId"]) != `"`+f.message.SessionID+`"` {
		t.Fatal(initial)
	}
	if ack := f.workerMessage(t, worker, snapshot); !reflect.DeepEqual(ack, snapshot) {
		t.Fatal(ack)
	}
	update := sessionWSRead(t, browser)
	var actual v2.Snapshot
	if err := json.Unmarshal(update["snapshot"], &actual); err != nil || !reflect.DeepEqual(actual, snapshot.Payload) {
		t.Fatal("browser snapshot encoding changed", update, err)
	}
	close(offerReady)
	frameKind, frame, err := worker.Read(ctx)
	if err != nil || frameKind != websocket.MessageText {
		t.Fatal("Worker offer was not a text frame", frameKind, err)
	}
	dispatched, err := v2.DecodeMessage(frame)
	if err != nil || !reflect.DeepEqual(dispatched, offer) {
		t.Fatal("Worker dispatch changed the supplied offer", string(frame), err)
	}
	terminalAwait(t, revokePoll, "viewer did not start its next controlled state read")
	revokeOnce.Do(func() { close(revoke) })
	if _, _, err = browser.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("provided viewer refusal did not close the socket", err)
	}
	terminalAwait(t, viewerReleased, "viewer release did not finish")
	refused := terminalRequest(viewerHandler, http.MethodGet, path+"/state", "", v2.Protocol)
	failure := decodeResponse[api.ErrorResponse](t, refused, http.StatusForbidden)
	if failure.Error.Code != "forbidden" || failure.Error.RequestID != refused.Header().Get("X-Request-ID") {
		t.Fatal(failure)
	}
	if response := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol); response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	_ = worker.CloseNow()
	terminalAwait(t, workerReleased, "worker release did not finish")
	f.waitConnections(t, 0)
}

func TestTerminalDuplicateChannelsPreserveAdmittedConnections(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	browserID := uuid.NewString()
	releaseEntered, releaseDone, workerDone, release := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	var binds, viewerReleases atomic.Int32
	f.calls.ExpectCalls("RegisterTerminal", 2)
	f.calls.ExpectCalls("BindTerminalConnection", 2)
	f.calls.ExpectCalls("DisconnectTerminalViewer", 2)
	f.calls.AllowRepeated("TerminalState")
	f.calls.AllowRepeated("PollTerminal")
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.RegisterTerminal = func(call context.Context, p model.Principal, project, task string, message v2.Message) (v2.Message, error) {
			f.scope(t, call, p, project, task, message.SessionID)
			if !reflect.DeepEqual(message, f.message) {
				t.Error("duplicate registration changed the parsed intent")
			}
			return f.ack("1"), nil
		}
		calls.BindTerminalConnection = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, call, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("duplicate binding changed its supplied identity")
			}
			if binds.Add(1) == 2 {
				return &model.Fault{Code: "input_busy", Message: "The connection epoch is already bound."}
			}
			return nil
		}
		calls.PollTerminal = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
			if err := call.Err(); err != nil {
				return nil, err
			}
			f.scope(t, call, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("polling left the admitted Worker")
			}
			return []v2.Message{}, nil
		}
		calls.TerminalState = func(call context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			if err := call.Err(); err != nil {
				return nil, err
			}
			f.scope(t, call, p, project, task, id)
			return f.knownState("1"), nil
		}
		calls.DisconnectTerminal = func(call context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, call, p, project, task, id)
			terminalReleaseContext(t, call)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("Worker cleanup changed its admitted connection")
			}
			close(workerDone)
			return nil
		}
		calls.DisconnectTerminalViewer = func(call context.Context, p model.Principal, project, task, id, browser, claim, epoch string) error {
			f.scope(t, call, p, project, task, id)
			terminalReleaseContext(t, call)
			if browser != browserID || claim != f.message.ClaimID || epoch != "1" {
				t.Error("viewer release changed its reservation identity")
			}
			if viewerReleases.Add(1) == 1 {
				close(releaseEntered)
				select {
				case <-release:
				case <-call.Done():
					return call.Err()
				}
				close(releaseDone)
			}
			return nil
		}
	})
	dial := func(suffix string, headers http.Header) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, f.server.URL+path+suffix, &websocket.DialOptions{HTTPHeader: headers, Subprotocols: []string{v2.Protocol}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.CloseNow() })
		return conn
	}
	worker := dial("/worker-channel", f.workerHeaders())
	f.handshake(t, worker)
	duplicate := dial("/worker-channel", f.workerHeaders())
	sessionWSWrite(t, duplicate, f.message)
	if _, _, err := duplicate.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("refused duplicate Worker did not close", err)
	}
	f.waitConnections(t, 1)
	if f.calls.Called("DisconnectTerminal") != 0 {
		t.Fatal("failed duplicate admission disconnected the original Worker")
	}
	browser := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	sessionWSRead(t, browser)
	duplicateViewer := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	if _, _, err := duplicateViewer.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("duplicate browser did not close", err)
	}
	if f.calls.Called("DisconnectTerminalViewer") != 0 {
		t.Fatal("duplicate viewer released the original reservation")
	}
	_ = browser.CloseNow()
	terminalAwait(t, releaseEntered, "original viewer cleanup did not start")
	blockedReplacement := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	if _, _, err := blockedReplacement.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("viewer identity reopened before cleanup finished", err)
	}
	if f.calls.Called("DisconnectTerminalViewer") != 1 {
		t.Fatal("rejected replacement ran an unrelated release")
	}
	releaseOnce.Do(func() { close(release) })
	terminalAwait(t, releaseDone, "viewer cleanup did not finish")
	f.waitConnections(t, 1)
	replacement := dial("/channel?browserClientId="+browserID, f.viewerHeaders(f.h))
	sessionWSRead(t, replacement)
	_ = replacement.CloseNow()
	f.waitConnections(t, 1)
	_ = worker.CloseNow()
	terminalAwait(t, workerDone, "original Worker did not disconnect")
	f.waitConnections(t, 0)
}

type terminalArchiveLease struct{ calls atomic.Int32 }

func (lease *terminalArchiveLease) Close() error { lease.calls.Add(1); return nil }

func terminalArchiveReady(t *testing.T) (*terminalHTTPFixture, string, []byte, v2.Receipt) {
	t.Helper()
	f := terminalHTTPSetup(t)
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	document.SessionID, document.ClaimID, document.Owner = f.message.SessionID, f.message.ClaimID, f.message.Payload.(v2.Registration).Owner
	for index := range document.Runs {
		document.Runs[index].Owner = document.Owner
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n \t\n")...)
	hash, size, complete := v2.HashBytes(data), strconv.Itoa(len(data)), "complete"
	receipt := v2.Receipt{FinalizationID: document.FinalizationID, Disposition: "ready", SHA256: &hash, ByteLength: &size, Completeness: &complete}
	message := f.message
	message.Type, message.Payload = "receipt", receipt
	receipt.DispositionDigest, err = v2.ReceiptDigest(message)
	if err != nil {
		t.Fatal(err)
	}
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.TryReserveArchivePreflight = func() (io.Closer, error) {
			lease := &terminalArchiveLease{}
			t.Cleanup(func() {
				if lease.calls.Load() != 1 {
					t.Errorf("archive reservation closes = %d, want 1", lease.calls.Load())
				}
			})
			return lease, nil
		}
		calls.TerminalArchiveContentReserved = func(ctx context.Context, p model.Principal, project, task, id string, reservation io.Closer) (sessionhttp.ArchiveContentForTest, error) {
			f.scope(t, ctx, p, project, task, id)
			if reservation == nil {
				t.Error("archive read lost its admission reservation")
			}
			lease := &terminalArchiveLease{}
			t.Cleanup(func() {
				if lease.calls.Load() != 1 {
					t.Errorf("archive content closes = %d, want 1", lease.calls.Load())
				}
			})
			return sessionhttp.ArchiveContentForTest{Data: data, Closer: lease}, nil
		}
	})
	return f, f.base + "/" + f.message.SessionID + "/archive", data, receipt
}

func TestTerminalArchiveDownloadPreservesReceiptBytes(t *testing.T) {
	f, path, data, receipt := terminalArchiveReady(t)
	response := terminalRequest(f.h, http.MethodGet, path+"/content", "", v2.Protocol)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), data) {
		t.Fatal("archive content bytes changed", response.Code, response.Body.String())
	}
	if receipt.SHA256 == nil || *receipt.SHA256 != v2.HashBytes(response.Body.Bytes()) || receipt.ByteLength == nil || *receipt.ByteLength != strconv.Itoa(response.Body.Len()) {
		t.Fatal("provided receipt no longer describes the sent bytes", receipt)
	}
	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatal(response.Header())
	}
}

func TestTerminalArchiveStateHTTPPreservesProvidedReadbackAndFaults(t *testing.T) {
	f := terminalHTTPSetup(t)
	before, archived := f.knownState("1"), f.knownState("1")
	archived["connected"] = false
	var states, archives atomic.Int32
	foreignID := uuid.NewString()
	f.calls.ExpectCalls("TerminalState", 2)
	f.calls.ExpectCalls("TerminalArchiveState", 2)
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			if states.Add(1) == 1 {
				return before, nil
			}
			return nil, &model.Fault{Code: "not_found", Message: "The ordinary Session is unavailable."}
		}
		calls.TerminalArchiveState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			if archives.Add(1) == 1 {
				f.scope(t, ctx, p, project, task, id)
				return archived, nil
			}
			owner := f.message.Payload.(v2.Registration).Owner
			if ctx.Err() != nil || p != f.h.principal || id != foreignID || project != owner.ProjectID || task != owner.TaskID {
				t.Error("foreign archive read changed its route arguments")
			}
			return nil, &model.Fault{Code: "not_found", Message: "The requested Session does not exist."}
		}
		calls.TerminalHistory = func(ctx context.Context, p model.Principal, project, task, cursor string, limit int) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			if cursor != "" || limit != 50 {
				t.Error("default history query changed")
			}
			return nil, &model.Fault{Code: "not_found", Message: "The Task is unavailable."}
		}
	})
	path := f.base + "/" + f.message.SessionID
	initial := decodeResponse[map[string]any](t, terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol), http.StatusOK)
	after := decodeResponse[map[string]any](t, terminalRequest(f.h, http.MethodGet, path+"/archive/state", "", v2.Protocol), http.StatusOK)
	if after["connected"] != false || len(after) != len(initial) {
		t.Fatal(after)
	}
	for _, key := range []string{"protocol", "schemaVersion", "projectionVersion", "sessionId", "claimId", "executionGeneration", "owner", "binding", "ledger", "recording", "archive"} {
		if !reflect.DeepEqual(after[key], initial[key]) {
			t.Fatal("archive response changed provided field", key, after[key], initial[key])
		}
	}
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol), http.StatusNotFound, "not_found")
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, f.base, "", v2.Protocol), http.StatusNotFound, "not_found")
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, f.base+"/"+foreignID+"/archive/state", "", v2.Protocol), http.StatusNotFound, "not_found")
	invalid := terminalRequest(f.h, http.MethodGet, f.base+"/not-a-uuid/archive/state", "", v2.Protocol)
	if invalid.Code != http.StatusBadRequest {
		t.Fatal(invalid.Code, invalid.Body.String())
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
