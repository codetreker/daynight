package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	h        *resourceTestHandler
	app      *sessionApplication
	backend  *sessionHTTPFixture
	record   map[string]any
	inserted *store.TerminalRegistration
	saved    []byte
	plan     *httpCallPlan
	server   *httptest.Server
	base     string
	message  v2.Message
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
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: w.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: projectID, TaskID: task.ID, WorkerID: w.WorkerID, WorktreeID: w.WorktreeID, OwnerUserID: h.principal.UserID, ServerOrigin: cfg.Server.PublicOrigin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
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
	ctx := context.Background()
	reg := f.message.Payload.(v2.Registration)
	native := "original-native"
	reg.Binding.NativeSessionID = &native
	reg.Capabilities = v2.Capabilities{}
	f.message.Payload = reg
	f.expect(t, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1})
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	if f.inserted == nil || f.inserted.OwnerID != f.h.principal.UserID || f.inserted.SessionID != f.message.SessionID || !bytes.Equal(f.inserted.Registration, []byte(jsonBody(t, reg))) || f.inserted.ServerInstance == "" || f.inserted.LastSeen.IsZero() {
		t.Fatal("terminal registration changed declared identity")
	}
	f.record = map[string]any{"Envelope": f.message.Envelope, "Registration": reg, "RegistrationDigest": v2.HashBytes([]byte(jsonBody(t, f.message))), "RegistrationEpoch": "1", "Owner": reg.Owner, "Binding": reg.Binding, "Runs": []v2.Run{}, "ConnectionEpoch": "1", "ControlEpoch": "0", "LastLeaseSeq": "0", "ServerInstance": f.inserted.ServerInstance, "LastSeen": f.inserted.LastSeen, "Recording": map[string]any{}}
	ledger := v2.GenerationLedger{Runs: []v2.Run{{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}}}
	f.expect(t, terminalRecoveryCalls("LockArchiveTask", map[string]int{"SaveTerminal": 1}))
	f.messageRequest(t, "generation_ledger", ledger)
	f.assertSaved(t, "Runs", ledger.Runs)
	f.record["Runs"] = ledger.Runs
	control := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	f.expect(t, terminalRecoveryCalls("LockTask", map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}))
	f.messageRequest(t, "control_state", control)
	f.assertSaved(t, "Control", control)
	f.record["Control"] = control
	f.record["ControlEpoch"] = "1"
	f.expect(t, terminalRecoveryCalls("LockTask", map[string]int{"SaveTerminal": 1}))
	if err := f.app.service.BindTerminalConnection(ctx, f.h.principal, reg.Owner.ProjectID, reg.Owner.TaskID, f.message.SessionID, f.message.Envelope, "1"); err != nil {
		t.Fatal(err)
	}
	f.assertSaved(t, "ChannelEpoch", "1")
	f.record["ChannelEpoch"] = "1"
	prepare := v2.AutomationRecoveryPrepare{RecoveryID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: uuid.NewString(), Binding: reg.Binding, InitialAssignment: "transport_completed"}
	f.expect(t, terminalRecoveryCalls("LockArchiveTask", map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1}))
	ack := f.messageRequest(t, "automation_recovery_prepare", prepare)
	expectedState := v2.AutomationRecoveryState{RecoveryID: prepare.RecoveryID, PrepareDigest: ack.Payload.(v2.AutomationRecoveryState).PrepareDigest, SourceGeneration: "1", SourceConnectionEpoch: "1", SourceControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: prepare.StopOperationID, NativeSessionID: native}
	if !reflect.DeepEqual(ack.Payload, expectedState) {
		t.Fatal("recovery receipt changed independently declared intent")
	}
	f.record["AutomationRecoveries"] = map[string]any{prepare.RecoveryID: map[string]any{"State": expectedState, "Invalidated": false}}
	f.record["ControlEpoch"] = "2"
	f.record["Control"] = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "closing", InitialAssignment: "transport_completed", AvailableActions: []string{}}
	path := f.base + "/" + f.message.SessionID + "/automation-recovery/" + prepare.RecoveryID
	f.expect(t, terminalRecoveryCalls("LockArchiveTask", nil))
	read := terminalMessage(t, terminalRequest(f.h, http.MethodGet, path, "", v2.Protocol))
	if jsonBody(t, read) != jsonBody(t, ack) {
		t.Fatal("readback changed original preparation")
	}
	for _, probe := range []struct {
		method, path, protocol string
		status                 int
	}{{"GET", path + "?unexpected=1", v2.Protocol, 400}, {"HEAD", path, v2.Protocol, 405}, {"GET", f.base + "/" + f.message.SessionID + "/automation-recovery/" + uuid.NewString(), v2.Protocol, 404}} {
		if probe.status == 404 {
			f.expect(t, terminalRecoveryCalls("LockArchiveTask", nil))
		}
		w := terminalRequest(f.h, probe.method, probe.path, "", probe.protocol)
		if w.Code != probe.status {
			t.Fatal(probe, w.Code, w.Body.String())
		}
	}
	f.expect(t, terminalRecoveryCalls("LockTask", map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}))
	state := terminalRequest(f.h, "GET", f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol)
	if state.Code != 200 || strings.Contains(state.Body.String(), "prepareDigest") {
		t.Fatal("ordinary strict state shape changed", state.Code, state.Body.String())
	}
}

func terminalRecoveryCalls(lock string, work map[string]int) map[string]int {
	counts := map[string]int{lock: 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}
	for name, n := range work {
		counts[name] = n
	}
	return counts
}
func (f *terminalHTTPFixture) expect(t *testing.T, counts map[string]int) {
	t.Helper()
	f.plan = newHTTPCallPlan(t, counts)
	f.saved = nil
	f.backend.store.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		return f.run(ctx, fn)
	}
}
func (f *terminalHTTPFixture) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	d := &terminalRecoveryDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: f.backend.store.t}, f: f, t: f.backend.store.t}
	err := fn(sessionHTTPScope{t: f.backend.store.t, dao: d})
	f.plan.Verify()
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *terminalHTTPFixture) assertSaved(t *testing.T, key string, expected any) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(f.saved, &fields); err != nil {
		t.Fatal("terminal write missing", err)
	}
	var actual, independent any
	if err := json.Unmarshal(fields[key], &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(jsonBody(t, expected)), &independent); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, independent) {
		t.Fatalf("terminal saved %s=%#v, want %#v", key, actual, independent)
	}
}

type terminalRecoveryDAO struct {
	sessionHTTPRejectedDAO
	f *terminalHTTPFixture
	t *testing.T
}

func (d *terminalRecoveryDAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.f.plan.Called("LockTask")
	return d.task(ctx, project, id)
}
func (d *terminalRecoveryDAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	d.f.plan.Called("LockArchiveTask")
	v, err := d.task(ctx, project, id)
	return v, false, err
}
func (d *terminalRecoveryDAO) task(ctx context.Context, project, id string) (store.SessionTask, error) {
	if project != d.f.backend.task.ProjectID || id != d.f.backend.task.ID {
		unexpectedHTTPCall(d.t, "Terminal Task address")
	}
	return sessionHTTPCopy(d.f.backend.sessionTask), ctx.Err()
}
func (d *terminalRecoveryDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.f.plan.Called("LockCredential")
	if p != d.f.h.principal || now.IsZero() {
		unexpectedHTTPCall(d.t, "Terminal principal")
	}
	return ctx.Err()
}
func (d *terminalRecoveryDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.f.plan.Called("ProjectAccess")
	if user != d.f.h.principal.UserID || project != d.f.backend.task.ProjectID {
		unexpectedHTTPCall(d.t, "Terminal Project access")
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, ctx.Err()
}
func (d *terminalRecoveryDAO) LockTaskRegistration(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.f.plan.Called("LockTaskRegistration")
	return d.task(ctx, project, id)
}
func (d *terminalRecoveryDAO) FindTerminalRegistration(ctx context.Context, id, project, registration, task, claim string) (string, error) {
	d.f.plan.Called("FindTerminalRegistration")
	in := d.f.message.Payload.(v2.Registration)
	if id != d.f.message.SessionID || registration != in.RegistrationID || claim != d.f.message.ClaimID || project != in.Owner.ProjectID || task != in.Owner.TaskID {
		unexpectedHTTPCall(d.t, "Terminal registration address")
	}
	return "", model.ErrNotFound
}
func (d *terminalRecoveryDAO) InsertTerminal(ctx context.Context, in store.TerminalRegistration) error {
	d.f.plan.Called("InsertTerminal")
	d.f.inserted = new(sessionHTTPCopy(in))
	return ctx.Err()
}
func (d *terminalRecoveryDAO) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	d.f.plan.Called("LockTerminal")
	if id != d.f.message.SessionID {
		unexpectedHTTPCall(d.t, "Terminal Session id")
	}
	return []byte(jsonBody(d.t, d.f.record)), ctx.Err()
}
func (d *terminalRecoveryDAO) SaveTerminal(ctx context.Context, id string, raw []byte, seen *time.Time, instance string) error {
	d.f.plan.Called("SaveTerminal")
	if id != d.f.message.SessionID || instance != d.f.inserted.ServerInstance || seen == nil {
		unexpectedHTTPCall(d.t, "Terminal write identity")
	}
	d.f.saved = bytes.Clone(raw)
	return ctx.Err()
}
func (d *terminalRecoveryDAO) ExpireTerminalOperations(ctx context.Context, id string, now time.Time) error {
	d.f.plan.Called("ExpireTerminalOperations")
	if id != d.f.message.SessionID || now.IsZero() {
		unexpectedHTTPCall(d.t, "Terminal expiry arguments")
	}
	return ctx.Err()
}
func (d *terminalRecoveryDAO) TerminalAutomationAllowed(ctx context.Context, task string) (bool, error) {
	d.f.plan.Called("TerminalAutomationAllowed")
	if task != d.f.backend.task.ID {
		unexpectedHTTPCall(d.t, "Terminal automation Task")
	}
	return true, ctx.Err()
}
func (d *terminalRecoveryDAO) TerminalInputPending(ctx context.Context, id string) (bool, error) {
	d.f.plan.Called("TerminalInputPending")
	if id != d.f.message.SessionID {
		unexpectedHTTPCall(d.t, "Terminal pending Session")
	}
	return false, ctx.Err()
}

func (d *terminalRecoveryDAO) TerminalArchive(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	d.f.plan.Called("TerminalArchive")
	if id != d.f.message.SessionID {
		unexpectedHTTPCall(d.t, "Terminal archive Session")
	}
	return v2.ArchiveStatus{}, nil, "", model.ErrNotFound
}

func (d *terminalRecoveryDAO) InvalidateTerminalOperations(ctx context.Context, id string) error {
	d.f.plan.Called("InvalidateTerminalOperations")
	if id != d.f.message.SessionID {
		unexpectedHTTPCall(d.t, "Terminal invalidate Session")
	}
	return ctx.Err()
}
