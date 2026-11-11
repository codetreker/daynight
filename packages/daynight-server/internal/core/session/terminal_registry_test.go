package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
	"testing"
)

func withinRecordingPhase[T any](f fixture, ctx context.Context, counts map[string]int, fn func(context.Context) (T, error)) (T, error) {
	phase := f.dao.ContextPhase(ctx, counts)
	defer f.dao.FinishContext(phase)
	return fn(phase)
}

func withinRecordingErrorPhase(f fixture, ctx context.Context, counts map[string]int, fn func(context.Context) error) error {
	phase := f.dao.ContextPhase(ctx, counts)
	defer f.dao.FinishContext(phase)
	return fn(phase)
}

func terminalFixture(t *testing.T) (fixture, v2.Message) {
	t.Helper()
	f := setup(t)
	f.s.Origin = "https://daynight.example"
	f.data.Task.Worker.AgentControlMode = model.AgentControlModeHerdr
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.r.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, OwnerUserID: f.p.UserID, ServerOrigin: f.s.Origin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	configureTerminalFixture(t, &f, m)
	return f, m
}
func TestTerminalRegistrationPreservesSharedRegistryAndRejectsForeignOwner(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	f.dao.Expect("InsertTerminal", 1)
	f.dao.Expect("FindTerminalRegistration", 2)
	a, e := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	})
	if e != nil {
		t.Fatal(e)
	}
	ack := a.Payload.(v2.RegistrationAck)
	if ack.ConnectionEpoch != "1" {
		t.Fatal(ack)
	}
	b, e := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	})
	if e != nil || b.Payload.(v2.RegistrationAck) != ack {
		t.Fatal(b, e)
	}
	if f.dao.Called("InsertTerminal") != 1 || f.terminal.Registration.SessionID != m.SessionID || f.terminal.Record(t).Envelope.AgentControlMode != "herdr" {
		t.Fatal("idempotent registration changed its shared registry write")
	}
	bad := m
	p := m.Payload.(v2.Registration)
	p.Owner.WorkerID = uuid.NewString()
	bad.Payload = p
	if _, e = terminalRegistrationStep(t, f, bad.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, bad)
		})
	}); e == nil {
		t.Fatal("foreign worker registration accepted")
	}
	old, e := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (map[string]any, error) { return f.s.Current(phase, f.p, f.project, f.task) })
	if e != nil || old["status"] != "not_applicable" {
		t.Fatal(old, e)
	}
	if _, e = withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1}, func(phase context.Context) (sp.ArchiveStatus, error) {
		return f.s.ArchiveStatus(phase, f.p, f.project, f.task, m.SessionID)
	}); e == nil {
		t.Fatal("v1 read terminal row")
	}
}
func TestTerminalWorkerChannelEpochIsConsumedOnce(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := terminalErrorStep(t, f, func() error {
		return withinRecordingErrorPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) error {
			return f.s.BindTerminalConnection(phase, f.p, f.project, f.task, m.SessionID, m.Envelope, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := terminalErrorStep(t, f, func() error {
		return withinRecordingErrorPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) error {
			return f.s.BindTerminalConnection(phase, f.p, f.project, f.task, m.SessionID, m.Envelope, "1")
		})
	}); err == nil {
		t.Fatal("two channels share an epoch")
	}
	reg := m.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch := "1"
	reg.ConnectionEpoch = &epoch
	m.Payload = reg
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := terminalErrorStep(t, f, func() error {
		return withinRecordingErrorPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) error {
			return f.s.BindTerminalConnection(phase, f.p, f.project, f.task, m.SessionID, m.Envelope, "1")
		})
	}); err == nil {
		t.Fatal("old connection binds")
	}
	if err := terminalErrorStep(t, f, func() error {
		return withinRecordingErrorPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) error {
			return f.s.BindTerminalConnection(phase, f.p, f.project, f.task, m.SessionID, m.Envelope, "2")
		})
	}); err != nil {
		t.Fatal(err)
	}
}
