package sessionrelay

import (
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"testing"
	"time"
)

func testSession(t *testing.T, initial string) (fixture, sp.Snapshot, string) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "claude", InitialInput: initial}
	v, e := f.s.RegisterTest(ctx, f.p, input)
	if e != nil {
		t.Fatal(e)
	}
	again, e := f.s.RegisterTest(ctx, f.p, input)
	if e != nil || again.SessionID != v.SessionID {
		t.Fatal("registration retry", e)
	}
	if _, e = sp.DecodeSnapshot(encode(v)); e != nil {
		t.Fatal("test snapshot codec", string(encode(v)), e)
	}
	changed := input
	changed.Provider = "codex"
	if _, e = f.s.RegisterTest(ctx, f.p, changed); e == nil {
		t.Fatal("registration collision")
	}
	grant, e := f.s.Grant(ctx, f.p, "", "", v.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if e != nil {
		t.Fatal(e)
	}
	epoch := uuid.NewString()
	v, e = f.s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: input.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	return f, v, epoch
}
func TestTestSessionUsesSharedRelayAndOwnerScope(t *testing.T) {
	f, v, epoch := testSession(t, "none")
	ctx := context.Background()
	// The test identity creates no task rows and cannot cross either HTTP scope.
	var count int
	if e := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM tasks`).Scan(&count); e != nil || count != 1 {
		t.Fatal("placeholder task", count, e)
	}
	if _, e := f.s.TestSnapshot(ctx, f.p, v.SessionID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "tail", "", 10); e == nil {
		t.Fatal("test via task path")
	}
	taskV, e := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.TestSnapshot(ctx, f.p, taskV.SessionID); e == nil {
		t.Fatal("task via test path")
	}
	outsider := f.p
	outsider.UserID = uuid.NewString()
	if _, e = f.s.TestSnapshot(ctx, outsider, v.SessionID); e == nil {
		t.Fatal("outsider read")
	}
	cmd := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"first input"}],"expectedTurnId":null}`)}
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, cmd); e == nil {
		t.Fatal("initializing send")
	}
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Respond: true}}
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); e != nil {
		t.Fatal(e)
	}
	snap, e := f.s.TestSnapshot(ctx, f.p, v.SessionID)
	if e != nil || !snap.Operations.CanSend {
		t.Fatal("ready no-prompt send", snap, e)
	}
	if _, e = sp.DecodeSnapshot(encode(snap)); e != nil {
		t.Fatal("ready snapshot codec", e)
	}
	receipt, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, cmd)
	if e != nil {
		t.Fatal(e)
	}
	offers, e := f.s.Poll(ctx, v.ControllerFence)
	if e != nil || len(offers) != 1 {
		t.Fatal("test poll", offers, e)
	}
	if offers[0]["testExecutionId"] != v.TestExecutionID || offers[0]["claimId"] != nil {
		t.Fatal("offer scope", offers)
	}
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: cmd.OperationID}); e != nil {
		t.Fatal(e)
	}
	receipt.State = "confirmed"
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); e != nil {
		t.Fatal(e)
	}
	_, events, _, e := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, EventCursor(v, "0"))
	if e != nil {
		t.Fatal(e)
	}
	for _, event := range events {
		if _, e = sp.DecodeEvent(encode(event)); e != nil {
			t.Fatal("event codec", event, e)
		}
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	archived, e := f.s.StopTest(ctx, f.p, v.SessionID, stop)
	if e != nil || archived.Lifecycle != "archived" {
		t.Fatal("stop", archived, e)
	}
	if _, e = f.s.StopTest(ctx, f.p, v.SessionID, stop); e != nil {
		t.Fatal("stop retry", e)
	}
	if _, e = f.s.Poll(ctx, v.ControllerFence); e == nil {
		t.Fatal("archived controller")
	}
	if _, e = f.s.TestSnapshot(ctx, f.p, v.SessionID); e != nil {
		t.Fatal("archived history", e)
	}
	archivedHistory, _, _, e := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, "")
	if e != nil || archivedHistory.Lifecycle != "archived" || archivedHistory.Operations.CanSend || archivedHistory.Operations.CanRespond {
		t.Fatal("archived browser history", archivedHistory, e)
	}
}
func TestTestSessionParentRevocationProtectsAllReads(t *testing.T) {
	f, v, _ := testSession(t, "prompt")
	ctx := context.Background()
	login := core.Principal{Kind: core.SessionCredential, UserID: f.p.UserID, CredentialID: uuid.NewString()}
	// Use a second valid PAT as a browser actor; parent revocation must still win.
	login.Kind = core.PATCredential
	if _, e := f.s.DB.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'second',now())`, login.CredentialID, login.UserID, []byte("01234567890123456789012345678901")); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.TestSnapshot(ctx, login, v.SessionID); e == nil {
		t.Fatal("revoked parent snapshot")
	}
	if _, _, _, e := f.s.BrowserPoll(ctx, login, "", "", v.SessionID, ""); e == nil {
		t.Fatal("revoked parent stream")
	}
	if _, e := f.s.Timeline(ctx, login, "", "", v.SessionID, "tail", "", 10); e == nil {
		t.Fatal("revoked parent timeline")
	}
	if _, _, e := f.s.Resource(ctx, login, "", "", v.SessionID, uuid.NewString()); e == nil {
		t.Fatal("revoked parent resource")
	}
	if _, e := f.s.Poll(ctx, v.ControllerFence); e == nil {
		t.Fatal("revoked controller")
	}
}

func TestDrainingOffersOnlyNewCleanupInteractions(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	var epoch string
	if e := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); e != nil {
		t.Fatal(e)
	}
	oldID, newID := uuid.NewString(), uuid.NewString()
	native := "native"
	seq := 0
	emit := func(kind string, payload any) {
		t.Helper()
		seq++
		_, e := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(int64(seq)), Kind: kind, Payload: encode(payload)}}})
		if e != nil {
			t.Fatal(e)
		}
	}
	entry := func(id string) map[string]any {
		return map[string]any{"entryId": id, "revision": "1", "kind": "interaction", "interaction": map[string]any{"interactionId": id, "revision": "1", "state": "pending", "title": "Approve", "kind": "approval", "detail": "cleanup", "actions": []string{"allow_once", "reject"}}}
	}
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "waiting_input", Capabilities: sp.Capabilities{Send: true, Respond: true}}
	emit("state", state)
	emit("timeline_upsert", entry(oldID))
	if _, e := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET draining_until=now()+interval '60 seconds',draining_timeline_seq=(snapshot->>'lastTimelineSeq')::bigint,snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"') WHERE id=$1`, v.SessionID); e != nil {
		t.Fatal(e)
	}
	emit("timeline_upsert", entry(newID))
	state.CleanupInteractionIDs = []string{newID}
	emit("state", state)
	snapshot, _, _, e := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if e != nil || !snapshot.Operations.CanRespond || snapshot.Operations.CanSend || snapshot.Operations.CanCancel {
		t.Fatal("draining permissions", snapshot, e)
	}
	if _, e = sp.DecodeSnapshot(encode(snapshot)); e != nil {
		t.Fatal("draining codec", e)
	}
	response := func(id string) sp.Command {
		return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "reply", OperationID: uuid.NewString(), Kind: "interaction_response", Payload: encode(sp.InteractionResponse{InteractionID: id, InteractionRevision: "1", SubmissionID: uuid.NewString(), Response: json.RawMessage(`{"kind":"approval","action":"allow_once"}`)})}
	}
	if _, e = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, response(oldID)); e == nil {
		t.Fatal("old pending response")
	}
	cmd := response(newID)
	if _, e = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, cmd); e != nil {
		t.Fatal("cleanup response", e)
	}
	offers, e := f.s.Poll(ctx, v.ControllerFence)
	if e != nil || len(offers) != 1 {
		t.Fatal("cleanup offer", offers, e)
	}
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: cmd.OperationID}); e != nil {
		t.Fatal("cleanup dispatch", e)
	}
	// A stale old request cannot become cleanup merely by being included in state.
	state.CleanupInteractionIDs = []string{oldID}
	seq++
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(int64(seq)), Kind: "state", Payload: encode(state)}}}); e == nil {
		t.Fatal("old interaction relabelled cleanup")
	}
}

func TestTestSessionNeverStartedStopRequiresUntouchedExecution(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	v, e := f.s.RegisterTest(ctx, f.p, registration)
	if e != nil {
		t.Fatal(e)
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	if _, e = sp.DecodeTestStop(encode(stop)); e != nil {
		t.Fatal("never started codec", e)
	}
	archived, e := f.s.StopTest(ctx, f.p, v.SessionID, stop)
	if e != nil || archived.Lifecycle != "archived" {
		t.Fatal("untouched archive", archived, e)
	}
	if _, e = f.s.StopTest(ctx, f.p, v.SessionID, stop); e != nil {
		t.Fatal("never started retry", e)
	}
	connected, cv, _ := testSession(t, "none")
	stop.Fence = cv.Fence
	stop.ControllerID = cv.Identity.ControllerID
	stop.ControllerInstanceID = cv.Identity.ControllerInstanceID
	stop.StopProof.PreviousControllerInstanceID = cv.Identity.ControllerInstanceID
	if _, e = connected.s.StopTest(ctx, connected.p, cv.SessionID, stop); e == nil {
		t.Fatal("connected masqueraded never started")
	}
	if e = connected.s.Disconnect(ctx, cv.ControllerFence); e != nil {
		t.Fatal(e)
	}
	if _, e = connected.s.StopTest(ctx, connected.p, cv.SessionID, stop); e == nil {
		t.Fatal("disconnected masqueraded never started")
	}
}
func TestTestSessionUnknownFirstInputCannotReplayUnderANewOperation(t *testing.T) {
	f, v, epoch := testSession(t, "none")
	ctx := context.Background()
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, e := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); e != nil {
		t.Fatal(e)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"once"}],"expectedTurnId":null}`)}
	receipt, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, command)
	if e != nil {
		t.Fatal(e)
	}
	replacement := command
	replacement.OperationID = uuid.NewString()
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, replacement); e == nil {
		t.Fatal("duplicate initial operation")
	}
	if _, e = f.s.Poll(ctx, v.ControllerFence); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); e != nil {
		t.Fatal(e)
	}
	receipt.State = "unknown"
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); e != nil {
		t.Fatal(e)
	}
	snapshot, e := f.s.TestSnapshot(ctx, f.p, v.SessionID)
	if e != nil || snapshot.Operations.CanSend {
		t.Fatal("unknown first input writable", e)
	}
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, replacement); e == nil {
		t.Fatal("unknown first input replayed")
	}
	retry, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, command)
	if e != nil || retry.State != "unknown" {
		t.Fatal("same operation reconciliation", retry, e)
	}
}

func TestTestSessionStopPreservesUncertainEffectsAndRejectsBadProofs(t *testing.T) {
	f, v, epoch := testSession(t, "prompt")
	ctx := context.Background()
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal(err)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"once"}],"expectedTurnId":null}`)}
	if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, command); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	neverOffered := command
	neverOffered.OperationID = uuid.NewString()
	if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, neverOffered); err != nil {
		t.Fatal(err)
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	bad := stop
	bad.ControllerInstanceID = uuid.NewString()
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("wrong instance proof")
	}
	bad = stop
	bad.StopProof.StoppedAt = time.Now().Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("future stop proof")
	}
	login := f.p
	login.Kind = core.SessionCredential
	if _, err := f.s.StopTest(ctx, login, v.SessionID, stop); err == nil {
		t.Fatal("browser submitted OS proof")
	}
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, stop); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{command.OperationID: "unknown", neverOffered.OperationID: "rejected"} {
		receipt, err := f.s.Operation(ctx, f.p, "", "", v.SessionID, id)
		if err != nil || receipt.State != want {
			t.Fatal("stop invented receipt", receipt, err)
		}
	}
	bad = stop
	bad.StopProof.RecordID = uuid.NewString()
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("conflicting proof retry")
	}
}

func TestTestRegistrationRefusesBrowserAndExpiredCredentials(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	browser := f.p
	browser.Kind = core.SessionCredential
	if _, err := f.s.RegisterTest(ctx, browser, input); err == nil {
		t.Fatal("browser registration admitted")
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RegisterTest(ctx, f.p, input); err == nil {
		t.Fatal("expired credential registration admitted")
	}
	var count int
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("refused registration persisted state", count, err)
	}
}
