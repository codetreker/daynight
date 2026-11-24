package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotRecoveryTakeoverFencesOldHostOperations(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	f, registered := serviceBoundBot(t, newServiceFixture(t), nil)
	const origin = "https://recovery.example"
	f.service.SetOrigin(origin)
	source := TransactionCommandAuthorization{Origin: origin}
	svc, err := NewScopedCommandsAndProducer(f.db, f.service.engine, source, source.SessionWrite)
	if err != nil {
		t.Fatal(err)
	}
	worker, replacement := registered.Bot.WorkerID, uuid.NewString()
	const machine = `{"machine":{"ID":"recovery-machine","Name":"Recovery machine"}}`
	if _, err = f.db.Pool.Exec(ctx, `UPDATE workers SET telemetry=$3 WHERE user_id=$1 AND worker_id=$2`, f.owner.UserID, worker, machine); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),$3,'{}')`, f.owner.UserID, replacement, machine); err != nil {
		t.Fatal(err)
	}

	v := registered.Session
	grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}
	bootstrap, err := svc.GrantBot(ctx, f.owner, worker, registered.Bot.ID, core.BotGrant{BotVersion: registered.Bot.Version, Grant: grant})
	if err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: grant.ControllerID, ControllerInstanceID: grant.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connect := func(token string) sp.Snapshot {
		t.Helper()
		connected, err := svc.Connect(ctx, token, hello, uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		if connected.Fence != v.Fence || connected.Identity.ControllerID != grant.ControllerID || connected.Identity.ControllerInstanceID != grant.ControllerInstanceID || connected.ConnectionEpoch == hello.ConnectionEpoch {
			t.Fatalf("connect changed execution/controller or reused connection epoch: %+v", connected.ControllerFence)
		}
		hello.ControllerFence = connected.ControllerFence
		return connected
	}
	original := connect(bootstrap.Token)
	native, turn := "recovery-native", uuid.NewString()
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "working", CurrentTurnID: &turn, Capabilities: sp.Capabilities{Send: true, Steer: true, Cancel: true}}
	sync := func(fence sp.ControllerFence) {
		t.Helper()
		if _, err := svc.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: fence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
			t.Fatal(err)
		}
	}
	sync(original.ControllerFence)
	identity := core.BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: origin, RecoveryIdentity: recoveryTestSecret(7)}
	binding := core.BotRecoveryBinding{SessionID: v.SessionID, TestExecutionID: v.TestExecutionID, NativeSessionID: &native}
	if _, err = svc.RegisterBotRecovery(ctx, f.owner, worker, registered.Bot.ID, core.BotRecoveryRegistration{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), BotVersion: registered.Bot.Version}); err != nil {
		t.Fatal(err)
	}

	submit := func(kind, payload string) sp.Operation {
		t.Helper()
		command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: kind, Payload: []byte(payload)}
		op, err := svc.Submit(ctx, f.owner, "", "", v.SessionID, command)
		if err != nil || op.State != "accepted" {
			t.Fatalf("submit %s: %+v %v", kind, op, err)
		}
		return op
	}
	send := func() sp.Operation {
		t.Helper()
		return submit("send_message", `{"content":[{"type":"text","text":"test input"}],"expectedTurnId":"`+turn+`"}`)
	}
	submitCancel := func() sp.Operation {
		t.Helper()
		return submit("cancel", `{"expectedTurnId":"`+turn+`"}`)
	}
	begin := func(fence sp.ControllerFence, op sp.Operation) (map[string]any, error) {
		return svc.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: fence, OperationID: op.OperationID})
	}
	assertOffers := func(fence sp.ControllerFence, want ...sp.Operation) {
		t.Helper()
		offers, err := svc.Poll(ctx, fence)
		if err != nil || len(offers) != len(want) {
			t.Fatalf("poll: got %v, want %d offers, err=%v", offers, len(want), err)
		}
		for i, offer := range offers {
			command, ok := offer["command"].(sp.Command)
			if !ok || offer["type"] != "operation_offer" || command.OperationID != want[i].OperationID {
				t.Fatalf("offer %d: got %v, want operation %s", i, offer, want[i].OperationID)
			}
		}
	}

	dispatching, unknown, offered, offeredCancel := send(), send(), send(), submitCancel()
	assertOffers(original.ControllerFence, dispatching, unknown, offered, offeredCancel)
	for _, op := range []sp.Operation{dispatching, unknown} {
		if reply, err := begin(original.ControllerFence, op); err != nil || reply["type"] != "operation_authorized" {
			t.Fatalf("begin %s: %v %v", op.OperationID, reply, err)
		}
	}
	unknown.State = "unknown"
	if _, err = svc.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: original.ControllerFence, Operation: &unknown}); err != nil {
		t.Fatal(err)
	}
	accepted, acceptedCancel := send(), submitCancel()
	rows := []struct {
		op     sp.Operation
		state  string
		row    string
		reject bool
	}{
		{op: accepted, state: "accepted", reject: true},
		{op: offered, state: "offered", reject: true},
		{op: dispatching, state: "dispatching"},
		{op: unknown, state: "unknown"},
		{op: acceptedCancel, state: "accepted"},
		{op: offeredCancel, state: "offered"},
	}
	readRow := func(op sp.Operation) (row, state, code string) {
		t.Helper()
		err := f.db.Pool.QueryRow(ctx, `SELECT to_jsonb(o)::text, receipt->>'state', coalesce(receipt->'error'->>'code','') FROM session_operations o WHERE session_id=$1 AND operation_id=$2`, v.SessionID, op.OperationID).Scan(&row, &state, &code)
		if err != nil {
			t.Fatal(err)
		}
		return row, state, code
	}
	for i := range rows {
		row, state, _ := readRow(rows[i].op)
		if state != rows[i].state {
			t.Fatalf("before recovery: operation %s is %s, want %s", rows[i].op.OperationID, state, rows[i].state)
		}
		rows[i].row = row
	}

	grant.Kind = "reconnect"
	input := core.BotRecoveryGrant{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), ExpectedHostingGeneration: 1, ControllerToken: "dncontroller_" + recoveryTestSecret(8), Grant: grant}
	if out, err := svc.GrantBotRecovery(ctx, f.owner, worker, registered.Bot.ID, input); err != nil || !out.Current || out.Receipt.WorkerID != worker || out.Receipt.HostingGeneration != 1 {
		t.Fatalf("same-host grant: %+v %v", out, err)
	}
	reconnected := connect(input.ControllerToken)
	for _, want := range rows {
		if row, _, _ := readRow(want.op); row != want.row {
			t.Fatalf("same-host reconnect changed %s %s operation %s", want.state, want.op.Kind, want.op.OperationID)
		}
	}

	input.OperationID = uuid.NewString()
	input.ControllerToken = "dncontroller_" + recoveryTestSecret(9)
	if out, err := svc.TakeoverBot(ctx, f.owner, replacement, registered.Bot.ID, input); err != nil || !out.Current || out.Receipt.WorkerID != replacement || out.Receipt.HostingGeneration != 2 {
		t.Fatalf("different-host takeover: %+v %v", out, err)
	}
	for _, want := range rows {
		row, state, code := readRow(want.op)
		if want.reject {
			if state != "rejected" || code != "permission_or_state_changed" {
				t.Errorf("takeover left %s operation %s at state=%s code=%q", want.state, want.op.OperationID, state, code)
			}
		} else if row != want.row {
			t.Errorf("takeover changed %s %s operation %s", want.state, want.op.Kind, want.op.OperationID)
		}
	}
	_, err = svc.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: reconnected.ControllerFence})
	requireServiceError(t, err, "session_conflict")
	next := connect(input.ControllerToken)
	reconciled, err := svc.Handle(ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: next.ControllerFence, Operations: []sp.Reconciliation{
		{OperationID: accepted.OperationID, State: "not_submitted"},
		{OperationID: offered.OperationID, State: "not_submitted"},
		{OperationID: offeredCancel.OperationID, State: "not_submitted"},
		{OperationID: dispatching.OperationID, State: "dispatching"},
	}, Final: true})
	if err != nil {
		t.Fatal(err)
	}
	receipts, ok := reconciled["operations"].([]sp.Operation)
	if !ok || len(receipts) != 4 {
		t.Fatalf("reconcile receipts: %+v", reconciled)
	}
	for i, op := range []sp.Operation{accepted, offered} {
		got := receipts[i]
		if got.OperationID != op.OperationID || got.State != "rejected" || got.ProviderResult != nil ||
			got.Error == nil || got.Error.Code != "permission_or_state_changed" {
			t.Fatalf("reconcile lost definite pre-dispatch refusal: %+v", got)
		}
	}
	if got := receipts[3]; got.OperationID != dispatching.OperationID || got.State != "unknown" {
		t.Fatalf("reconcile changed dispatch uncertainty: %+v", got)
	}
	sync(next.ControllerFence)
	fresh := send()
	assertOffers(next.ControllerFence, offeredCancel, acceptedCancel, fresh)
	for _, op := range []sp.Operation{accepted, offered} {
		_, err = begin(next.ControllerFence, op)
		requireServiceError(t, err, "session_conflict")
	}
	if reply, err := begin(next.ControllerFence, fresh); err != nil || reply["type"] != "operation_authorized" {
		t.Fatalf("begin new-host operation: %v %v", reply, err)
	}
}

func recoveryTestSecret(value byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}
