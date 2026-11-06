package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
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
	db      *postgres.Store
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
	return terminalHTTPFixture{h: h, app: app, db: db, server: server, base: taskPath(task) + "/sessions", message: m}
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
	if err := f.app.service.BindTerminalConnection(ctx, f.h.principal, reg.Owner.ProjectID, reg.Owner.TaskID, f.message.SessionID, f.message.Envelope, "1"); err != nil {
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
