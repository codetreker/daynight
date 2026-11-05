package session

import (
	"context"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
	"testing"
)

func terminalFixture(t *testing.T) (fixture, v2.Message) {
	t.Helper()
	f := setup(t)
	f.s.Origin = "https://daynight.example"
	if _, err := f.db.Pool.Exec(context.Background(), `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agentControlMode}','"herdr"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.r.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, OwnerUserID: f.p.UserID, ServerOrigin: f.s.Origin, Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	return f, m
}
func TestTerminalRegistrationPreservesSharedRegistryAndRejectsForeignOwner(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	a, e := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m)
	if e != nil {
		t.Fatal(e)
	}
	ack := a.Payload.(v2.RegistrationAck)
	if ack.ConnectionEpoch != "1" {
		t.Fatal(ack)
	}
	b, e := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m)
	if e != nil || b.Payload.(v2.RegistrationAck) != ack {
		t.Fatal(b, e)
	}
	var count int
	if e = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE id=$1 AND backend='herdr' AND snapshot IS NULL`, m.SessionID).Scan(&count); e != nil || count != 1 {
		t.Fatal(count, e)
	}
	bad := m
	p := m.Payload.(v2.Registration)
	p.Owner.WorkerID = uuid.NewString()
	bad.Payload = p
	if _, e = f.s.RegisterTerminal(ctx, f.p, f.project, f.task, bad); e == nil {
		t.Fatal("foreign worker registration accepted")
	}
	old, e := f.s.Current(ctx, f.p, f.project, f.task)
	if e != nil || old["status"] != "not_applicable" {
		t.Fatal(old, e)
	}
	if _, e = f.s.ArchiveStatus(ctx, f.p, f.project, f.task, m.SessionID); e == nil {
		t.Fatal("v1 read terminal row")
	}
}
func TestTerminalWorkerChannelEpochIsConsumedOnce(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	if err := f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, m.SessionID, m.Envelope, "1"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, m.SessionID, m.Envelope, "1"); err == nil {
		t.Fatal("two channels share an epoch")
	}
	reg := m.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch := "1"
	reg.ConnectionEpoch = &epoch
	m.Payload = reg
	if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	if err := f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, m.SessionID, m.Envelope, "1"); err == nil {
		t.Fatal("old connection binds")
	}
	if err := f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, m.SessionID, m.Envelope, "2"); err != nil {
		t.Fatal(err)
	}
}
