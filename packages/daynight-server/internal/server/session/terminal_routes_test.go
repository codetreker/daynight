package session_test

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

type terminalRecoveryFixture struct {
	h        *resourceTestHandler
	app      *realSessionApplication
	backend  *realSessionFixture
	record   map[string]any
	inserted *store.TerminalRegistration
	saved    []byte
	plan     *terminalRecoveryCallPlan
	t        *testing.T
	server   *httptest.Server
	base     string
	message  v2.Message
}

func terminalRecoverySetup(t *testing.T) terminalRecoveryFixture {
	t.Helper()
	backend := realSessionSetupMode(t, model.AgentControlModeHerdr, false)
	h, app, server := backend.handler, backend.application, backend.server
	task := backend.task
	w := backend.sessionTask.Worker
	projectID := task.ProjectID
	pane := "pane_1"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: w.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: projectID, TaskID: task.ID, WorkerID: w.WorkerID, WorktreeID: w.WorktreeID, OwnerUserID: h.principal.UserID, ServerOrigin: "https://daynight.example.com", Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	f := terminalRecoveryFixture{h: h, app: app, backend: backend, server: server, base: backend.base, message: m, t: t}
	return f
}
func (f terminalRecoveryFixture) messageRequest(t *testing.T, kind string, payload v2.Payload) v2.Message {
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
	f := terminalRecoverySetup(t)
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
func (f *terminalRecoveryFixture) expect(t *testing.T, counts map[string]int) {
	t.Helper()
	f.plan = newTerminalRecoveryCallPlan(t, counts)
	f.saved = nil
	f.backend.store.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		return f.run(ctx, fn)
	}
}
func (f *terminalRecoveryFixture) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	defer func() {
		if failure := recover(); failure != nil {
			f.t.Errorf("terminal transaction panicked: %v", failure)
			panic(failure)
		}
	}()
	d := &terminalRecoveryDAO{f: f, t: f.t}
	err := fn(realSessionScope{t: f.t, dao: d})
	f.plan.Verify()
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *terminalRecoveryFixture) assertSaved(t *testing.T, key string, expected any) {
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
	store.SessionDAO
	f *terminalRecoveryFixture
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
		terminalRecoveryUnexpected(d.t, "Terminal Task address")
	}
	return routeCopy(d.f.backend.sessionTask), ctx.Err()
}
func (d *terminalRecoveryDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.f.plan.Called("LockCredential")
	if p != d.f.h.principal || now.IsZero() {
		terminalRecoveryUnexpected(d.t, "Terminal principal")
	}
	return ctx.Err()
}
func (d *terminalRecoveryDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.f.plan.Called("ProjectAccess")
	if user != d.f.h.principal.UserID || project != d.f.backend.task.ProjectID {
		terminalRecoveryUnexpected(d.t, "Terminal Project access")
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
		terminalRecoveryUnexpected(d.t, "Terminal registration address")
	}
	return "", model.ErrNotFound
}
func (d *terminalRecoveryDAO) InsertTerminal(ctx context.Context, in store.TerminalRegistration) error {
	d.f.plan.Called("InsertTerminal")
	d.f.inserted = new(routeCopy(in))
	return ctx.Err()
}
func (d *terminalRecoveryDAO) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	d.f.plan.Called("LockTerminal")
	if id != d.f.message.SessionID {
		terminalRecoveryUnexpected(d.t, "Terminal Session id")
	}
	return []byte(jsonBody(d.t, d.f.record)), ctx.Err()
}
func (d *terminalRecoveryDAO) SaveTerminal(ctx context.Context, id string, raw []byte, seen *time.Time, instance string) error {
	d.f.plan.Called("SaveTerminal")
	if id != d.f.message.SessionID || instance != d.f.inserted.ServerInstance || seen == nil {
		terminalRecoveryUnexpected(d.t, "Terminal write identity")
	}
	d.f.saved = bytes.Clone(raw)
	return ctx.Err()
}
func (d *terminalRecoveryDAO) ExpireTerminalOperations(ctx context.Context, id string, now time.Time) error {
	d.f.plan.Called("ExpireTerminalOperations")
	if id != d.f.message.SessionID || now.IsZero() {
		terminalRecoveryUnexpected(d.t, "Terminal expiry arguments")
	}
	return ctx.Err()
}
func (d *terminalRecoveryDAO) TerminalAutomationAllowed(ctx context.Context, task string) (bool, error) {
	d.f.plan.Called("TerminalAutomationAllowed")
	if task != d.f.backend.task.ID {
		terminalRecoveryUnexpected(d.t, "Terminal automation Task")
	}
	return true, ctx.Err()
}
func (d *terminalRecoveryDAO) TerminalInputPending(ctx context.Context, id string) (bool, error) {
	d.f.plan.Called("TerminalInputPending")
	if id != d.f.message.SessionID {
		terminalRecoveryUnexpected(d.t, "Terminal pending Session")
	}
	return false, ctx.Err()
}

func (d *terminalRecoveryDAO) TerminalArchive(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	d.f.plan.Called("TerminalArchive")
	if id != d.f.message.SessionID {
		terminalRecoveryUnexpected(d.t, "Terminal archive Session")
	}
	return v2.ArchiveStatus{}, nil, "", model.ErrNotFound
}

func (d *terminalRecoveryDAO) InvalidateTerminalOperations(ctx context.Context, id string) error {
	d.f.plan.Called("InvalidateTerminalOperations")
	if id != d.f.message.SessionID {
		terminalRecoveryUnexpected(d.t, "Terminal invalidate Session")
	}
	return ctx.Err()
}

type terminalRecoveryCallPlan struct {
	t          *testing.T
	want, seen map[string]int
}

func newTerminalRecoveryCallPlan(t *testing.T, want map[string]int) *terminalRecoveryCallPlan {
	t.Helper()
	p := &terminalRecoveryCallPlan{t: t, want: want, seen: map[string]int{}}
	t.Cleanup(p.Verify)
	return p
}
func (p *terminalRecoveryCallPlan) Called(name string) {
	p.seen[name]++
	if p.seen[name] > p.want[name] {
		terminalRecoveryUnexpected(p.t, name)
	}
}
func (p *terminalRecoveryCallPlan) Verify() {
	p.t.Helper()
	for name, count := range p.want {
		if p.seen[name] != count {
			p.t.Errorf("DAO %s calls = %d, want %d", name, p.seen[name], count)
		}
	}
}
func terminalRecoveryUnexpected(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}
