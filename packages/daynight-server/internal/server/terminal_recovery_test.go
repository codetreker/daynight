package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
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

type terminalHTTPFixture struct {
	h       *resourceTestHandler
	app     *sessionApplication
	backend *sessionHTTPFixture
	server  *httptest.Server
	base    string
	message v2.Message
}

func terminalHTTPSetup(t *testing.T) terminalHTTPFixture {
	t.Helper()
	backend := sessionHTTPSetupMode(t, model.AgentControlModeHerdr, false)
	h, app, server := backend.handler, backend.application, backend.server
	task := backend.task
	w := apiWorker(t, task.Properties)
	cfg := configuredTestConfig()
	projectID := task.ProjectID
	pane := "pane_1"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: w.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: projectID, TaskID: task.ID, WorkerID: w.WorkerID, WorktreeID: w.WorktreeID, OwnerUserID: h.principal.UserID, ServerOrigin: cfg.PublicOrigin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	f := terminalHTTPFixture{h: h, app: app, backend: backend, server: server, base: taskPath(task) + "/sessions", message: m}
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
	reg := f.message.Payload.(v2.Registration)
	native := "original-native"
	reg.Binding.NativeSessionID = &native
	reg.Capabilities = v2.Capabilities{}
	f.message.Payload = reg
	registration := terminalEnvelopeForTest(f.message, "registration_ack", v2.RegistrationAck{RegistrationID: reg.RegistrationID, ConnectionEpoch: "1"})
	f.expectRegistration(t, f.message, registration)
	if actual := terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol)); !reflect.DeepEqual(actual, registration) {
		t.Fatal("terminal registration response changed declared identity")
	}

	ledger := v2.GenerationLedger{Runs: []v2.Run{{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}}}
	ledgerMessage := terminalEnvelopeForTest(f.message, "generation_ledger", ledger)
	f.expectWorkerMessage(t, "ledger", ledgerMessage, ledgerMessage)
	if actual := f.messageRequest(t, "generation_ledger", ledger); !reflect.DeepEqual(actual, ledgerMessage) {
		t.Fatal("ledger response changed complete supplied runs")
	}
	control := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	controlMessage := terminalEnvelopeForTest(f.message, "control_state", control)
	f.expectWorkerMessage(t, "control", controlMessage, controlMessage)
	if actual := f.messageRequest(t, "control_state", control); !reflect.DeepEqual(actual, controlMessage) {
		t.Fatal("control response changed complete supplied state")
	}

	prepare := v2.AutomationRecoveryPrepare{RecoveryID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: uuid.NewString(), Binding: reg.Binding, InitialAssignment: "transport_completed"}
	expectedState := v2.AutomationRecoveryState{RecoveryID: prepare.RecoveryID, PrepareDigest: strings.Repeat("a", 64), SourceGeneration: "1", SourceConnectionEpoch: "1", SourceControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: prepare.StopOperationID, NativeSessionID: native}
	preparedMessage := terminalEnvelopeForTest(f.message, "automation_recovery_state", expectedState)
	f.expectWorkerMessage(t, "recovery", terminalEnvelopeForTest(f.message, "automation_recovery_prepare", prepare), preparedMessage)
	ack := f.messageRequest(t, "automation_recovery_prepare", prepare)
	if !reflect.DeepEqual(ack, preparedMessage) {
		t.Fatal("recovery receipt changed independently declared intent")
	}
	path := f.base + "/" + f.message.SessionID + "/automation-recovery/" + prepare.RecoveryID
	f.expectRecoveryRead(t, prepare.RecoveryID, preparedMessage, nil)
	read := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol))
	if jsonBody(t, read) != jsonBody(t, ack) {
		t.Fatal("readback changed original preparation")
	}
	unknown := uuid.NewString()
	f.expectRecoveryRead(t, unknown, v2.Message{}, &model.Fault{Code: "not_found", Message: "The original automation recovery intent is not registered."})
	for _, probe := range []struct {
		method, path, protocol string
		status                 int
	}{{"GET", path + "?unexpected=1", v2.Protocol, 400}, {"HEAD", path, v2.Protocol, 405}, {"GET", f.base + "/" + f.message.SessionID + "/automation-recovery/" + unknown, v2.Protocol, 404}} {
		w := terminalRequest(f.h, probe.method, probe.path, "", probe.protocol)
		if w.Code != probe.status {
			t.Fatal(probe, w.Code, w.Body.String())
		}
	}
	closing := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "closing", InitialAssignment: "transport_completed", AvailableActions: []string{}}
	stateResult := map[string]any{"status": "registered", "protocol": v2.Protocol, "schemaVersion": 2, "projectionVersion": 1, "sessionId": f.message.SessionID, "claimId": f.message.ClaimID, "executionGeneration": "1", "agentControlMode": "herdr", "contentKind": "terminal_recording", "owner": reg.Owner, "binding": reg.Binding, "connectionEpoch": "1", "connected": true, "capabilities": reg.Capabilities, "control": closing, "snapshot": nil, "ledger": ledger, "archive": v2.ArchiveStatus{State: "pending"}, "recording": []map[string]any{{"executionGeneration": "1", "responsibility": nil, "evidence": nil}}}
	expectedDocument := startupClone(t, stateResult)
	supplied := startupClone(t, stateResult)
	called := startupOnce(t)
	f.backend.ops.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
		called()
		f.check(t, ctx, p, project, task, id)
		return startupClone(t, supplied), nil
	}
	state := terminalRequest(f.h, "GET", f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol)
	var document map[string]any
	if err := json.Unmarshal(state.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if state.Code != 200 || strings.Contains(state.Body.String(), "prepareDigest") || !reflect.DeepEqual(document, expectedDocument) {
		t.Fatal("ordinary strict state shape changed", state.Code, state.Body.String())
	}
}

func terminalEnvelopeForTest(in v2.Message, kind string, payload v2.Payload) v2.Message {
	e := in.Envelope
	e.Type = kind
	return v2.Message{Envelope: e, Payload: payload}
}
func terminalCloneForTest(t *testing.T, in v2.Message) v2.Message {
	t.Helper()
	out := in
	switch payload := in.Payload.(type) {
	case v2.Registration:
		out.Payload = startupClone(t, payload)
	case v2.RegistrationAck:
		out.Payload = startupClone(t, payload)
	case v2.GenerationLedger:
		out.Payload = startupClone(t, payload)
	case v2.ControlState:
		out.Payload = startupClone(t, payload)
	case v2.AutomationRecoveryPrepare:
		out.Payload = startupClone(t, payload)
	case v2.AutomationRecoveryState:
		out.Payload = startupClone(t, payload)
	default:
		t.Fatalf("unconfigured terminal payload clone: %T", payload)
	}
	return out
}
func (f *terminalHTTPFixture) check(t *testing.T, ctx context.Context, p model.Principal, project, task, id string) {
	t.Helper()
	if ctx == nil || ctx.Err() != nil || p != f.h.principal || project != f.backend.task.ProjectID || task != f.backend.task.ID || id != f.message.SessionID {
		unexpectedHTTPCall(t, "Terminal operation context, principal or full address")
	}
}
func (f *terminalHTTPFixture) expectRegistration(t *testing.T, want, result v2.Message) {
	t.Helper()
	want = terminalCloneForTest(t, want)
	result = terminalCloneForTest(t, result)
	called := startupOnce(t)
	f.backend.ops.RegisterTerminal = func(ctx context.Context, p model.Principal, project, task string, actual v2.Message) (v2.Message, error) {
		called()
		f.check(t, ctx, p, project, task, actual.SessionID)
		if !reflect.DeepEqual(actual, want) {
			t.Errorf("terminal registration=%#v, want %#v", actual, want)
			panic("registration input changed")
		}
		return terminalCloneForTest(t, result), nil
	}
}
func (f *terminalHTTPFixture) expectWorkerMessage(t *testing.T, kind string, want, result v2.Message) {
	t.Helper()
	want = terminalCloneForTest(t, want)
	result = terminalCloneForTest(t, result)
	called := startupOnce(t)
	operation := func(ctx context.Context, p model.Principal, project, task, id, epoch string, actual v2.Message) (v2.Message, error) {
		called()
		f.check(t, ctx, p, project, task, id)
		if epoch != "1" || !reflect.DeepEqual(actual, want) {
			t.Errorf("terminal %s message/epoch=%#v/%q, want %#v/1", kind, actual, epoch, want)
			panic("terminal worker input changed")
		}
		return terminalCloneForTest(t, result), nil
	}
	switch kind {
	case "ledger":
		f.backend.ops.UpdateTerminalLedger = operation
	case "control":
		f.backend.ops.HandleTerminalControl = operation
	case "recovery":
		f.backend.ops.UpdateTerminalRecovery = operation
	default:
		t.Fatal("unknown terminal operation plan", kind)
	}
}
func (f *terminalHTTPFixture) expectRecoveryRead(t *testing.T, recovery string, result v2.Message, resultErr error) {
	t.Helper()
	if resultErr == nil {
		result = terminalCloneForTest(t, result)
	}
	called := startupOnce(t)
	f.backend.ops.TerminalAutomationRecovery = func(ctx context.Context, p model.Principal, project, task, id, actualRecovery string) (v2.Message, error) {
		called()
		f.check(t, ctx, p, project, task, id)
		if actualRecovery != recovery {
			unexpectedHTTPCall(t, "terminal recovery identity")
		}
		if resultErr != nil {
			return v2.Message{}, resultErr
		}
		return terminalCloneForTest(t, result), nil
	}
}
