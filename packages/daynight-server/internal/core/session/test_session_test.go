package session

import (
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
	"time"
)

func standaloneTestFixture(t *testing.T) fixture {
	t.Helper()
	f := setup(t)
	f.dao.LockTestOwnerFn = func(_ context.Context, owner string) error {
		if owner != f.p.UserID {
			t.Fatalf("unexpected Test Session owner %s", owner)
		}
		return nil
	}
	f.dao.InsertTestSessionFn = func(_ context.Context, value store.SessionRegistration) error {
		if f.data.Session != nil || value.OwnerID != f.p.UserID || value.ParentCredentialID != f.p.CredentialID || value.Location.ProjectID != "" || value.Location.TaskID != "" || value.ClaimID != "" || value.BotID != nil || value.Snapshot.TestExecutionID != value.TestExecutionID || value.Snapshot.SessionID != value.Location.SessionID {
			t.Fatalf("Test Session registration %+v", value)
		}
		f.writes.Registration = new(fixtureCopy(value))
		return nil
	}
	return f
}

func testSession(t *testing.T, initial string) (fixture, sp.Snapshot, string) {
	t.Helper()
	f := standaloneTestFixture(t)
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "claude", InitialInput: initial}
	f.dao.FindTestRegistrationFn = func(_ context.Context, owner, registration, execution string) (string, *string, error) {
		if owner != f.p.UserID || registration != input.RegistrationID || execution != input.TestExecutionID {
			t.Fatal("Test registration lookup changed its key")
		}
		return f.data.RegistrationID, f.data.RegistrationBotID, f.data.RegistrationError
	}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "InsertTestSession": 1})
	v, e := f.s.RegisterTest(ctx, f.p, input)
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectRegistrationWrite(t)
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 3, "LockTestOwner": 1, "FindTestRegistration": 1, "SessionBotID": 1, "LockSession": 1})
	again, e := f.s.RegisterTest(ctx, f.p, input)
	f.dao.FinishContext(ctx)
	if e != nil || again.SessionID != v.SessionID {
		t.Fatal("registration retry", e)
	}
	if _, e = sp.DecodeSnapshot(encode(v)); e != nil {
		t.Fatal("test snapshot codec", string(encode(v)), e)
	}
	changed := input
	changed.Provider = "codex"
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "SessionBotID": 1, "LockSession": 1})
	if _, e = f.s.RegisterTest(ctx, f.p, changed); e == nil {
		t.Fatal("registration collision")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	grant, e := f.s.Grant(ctx, f.p, "", "", v.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectSessionWrite(t)
	f.SelectGrantWrite(t)
	epoch := uuid.NewString()
	ctx = f.dao.ContextPhase(ctx, map[string]int{"SessionLocationByGrant": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "ConnectSession": 1, "SaveSession": 1})
	v, e = f.s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: input.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectConnectionWrite(t)
	synchronizeFixture(t, f, v)
	return f, v, epoch
}
func TestTestSessionUsesSharedRelayAndOwnerScope(t *testing.T) {
	f, v, epoch := testSession(t, "none")
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	ctx = f.BrowserPhase(ctx, nil)
	if _, e := f.s.TestSnapshot(ctx, f.p, v.SessionID); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, mergeFixtureCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, nil))
	if _, e := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "tail", "", 10); e == nil {
		t.Fatal("test via task path")
	}
	f.dao.FinishContext(ctx)
	testRecord, testLocation := f.data.Session, f.data.Location
	f.data.Session = nil
	f.data.RegistrationError = model.ErrNotFound
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1, "InsertTaskSession": 1})
	taskV, e := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectRegistrationWrite(t)
	ctx = f.dao.ContextPhase(ctx, map[string]int{"SessionBotID": 1, "LockSession": 1})
	if _, e = f.s.TestSnapshot(ctx, f.p, taskV.SessionID); e == nil {
		t.Fatal("task via test path")
	}
	f.dao.FinishContext(ctx)
	f.data.Session, f.data.Location = testRecord, testLocation
	outsider := addMember(t, f, "admin")
	ctx = f.BrowserPhase(ctx, map[string]int{"LockCredential": 1})
	if _, e = f.s.TestSnapshot(ctx, outsider, v.SessionID); e == nil {
		t.Fatal("project admin read another user's test session")
	}
	f.dao.FinishContext(ctx)
	cmd := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"first input"}],"expectedTurnId":null,"origin":"daynight"}`)}
	ctx = f.BrowserPhase(ctx, map[string]int{"LockCredential": 1})
	if _, e = f.s.Submit(ctx, outsider, "", "", v.SessionID, cmd); e == nil {
		t.Fatal("notification origin let another user submit")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1})
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, cmd); e == nil {
		t.Fatal("initializing send")
	}
	f.dao.FinishContext(ctx)
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Respond: true}}
	ctx = f.ControllerPhase(ctx, map[string]int{"TouchSession": 1, "SaveSession": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	selectContentHandle(t, f)
	ctx = f.BrowserPhase(ctx, nil)
	snap, e := f.s.TestSnapshot(ctx, f.p, v.SessionID)
	f.dao.FinishContext(ctx)
	if e != nil || !snap.Operations.CanSend {
		t.Fatal("ready no-prompt send", snap, e)
	}
	if _, e = sp.DecodeSnapshot(encode(snap)); e != nil {
		t.Fatal("ready snapshot codec", e)
	}
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	receipt, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, cmd)
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.data.OperationDeadline = f.s.now().Add(30 * time.Second)
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = []string{cmd.OperationID}
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 4, "AcceptedSessionOperations": 1, "SessionOperation": 1, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
	offers, e := f.s.Poll(ctx, v.ControllerFence)
	f.dao.FinishContext(ctx)
	if e != nil || len(offers) != 1 {
		t.Fatal("test poll", offers, e)
	}
	if offers[0]["testExecutionId"] != v.TestExecutionID || offers[0]["claimId"] != nil {
		t.Fatal("offer scope", offers)
	}
	var offered map[string]json.RawMessage
	if err := json.Unmarshal(encode(offers[0]["command"]), &offered); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(offered["payload"], &payload); err != nil || payload["origin"] != "daynight" {
		t.Fatal("controller offer lost notification origin", payload, err)
	}
	selectContentOffer(t, f)
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 4, "SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: cmd.OperationID}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	receipt.State = "confirmed"
	ctx = f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	ctx = f.BrowserPhase(ctx, nil)
	_, events, _, e := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, EventCursor(v, "0"))
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, event := range events {
		if _, e = sp.DecodeEvent(encode(event)); e != nil {
			t.Fatal("event codec", event, e)
		}
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	ctx = f.BrowserPhase(ctx, map[string]int{"StoppingTestOperations": 1, "SetTestSessionStop": 1, "SaveSession": 1})
	archived, e := f.s.StopTest(ctx, f.p, v.SessionID, stop)
	f.dao.FinishContext(ctx)
	if e != nil || archived.Lifecycle != "archived" {
		t.Fatal("stop", archived, e)
	}
	f.SelectSessionWrite(t)
	f.data.Session.StopProof = append([]byte(nil), f.writes.StopProof...)
	ctx = f.BrowserPhase(ctx, nil)
	if _, e = f.s.StopTest(ctx, f.p, v.SessionID, stop); e != nil {
		t.Fatal("stop retry", e)
	}
	f.dao.FinishContext(ctx)
	ctx = f.ControllerPhase(ctx, nil)
	if _, e = f.s.Poll(ctx, v.ControllerFence); e == nil {
		t.Fatal("archived controller")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, nil)
	if _, e = f.s.TestSnapshot(ctx, f.p, v.SessionID); e != nil {
		t.Fatal("archived history", e)
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, nil)
	archivedHistory, _, _, e := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, "")
	f.dao.FinishContext(ctx)
	if e != nil || archivedHistory.Lifecycle != "archived" || archivedHistory.Operations.CanSend || archivedHistory.Operations.CanRespond {
		t.Fatal("archived browser history", archivedHistory, e)
	}
}
func TestTestSessionParentRevocationProtectsAllReads(t *testing.T) {
	f, v, _ := testSession(t, "prompt")
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	login := listCredential(t, f, f.p.UserID, model.PATCredential)
	refusal := &model.Fault{Code: "unauthenticated", Message: "Parent credential is revoked."}
	f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
		if p == login {
			return nil
		}
		if p == f.p {
			return refusal
		}
		t.Fatalf("unexpected credential %+v", p)
		return nil
	}
	ctx = f.BrowserPhase(ctx, nil)
	if _, e := f.s.TestSnapshot(ctx, login, v.SessionID); e != refusal {
		t.Fatal("revoked parent snapshot")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, nil)
	if _, _, _, e := f.s.BrowserPoll(ctx, login, "", "", v.SessionID, ""); e != refusal {
		t.Fatal("revoked parent stream")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, nil)
	if _, e := f.s.Timeline(ctx, login, "", "", v.SessionID, "tail", "", 10); e != refusal {
		t.Fatal("revoked parent timeline")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, nil)
	if _, _, e := f.s.Resource(ctx, login, "", "", v.SessionID, uuid.NewString()); e != refusal {
		t.Fatal("revoked parent resource")
	}
	f.dao.FinishContext(ctx)
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 1})
	if _, e := f.s.Poll(ctx, v.ControllerFence); e != refusal {
		t.Fatal("revoked controller")
	}
	f.dao.FinishContext(ctx)
}

func TestDrainingPreservesCleanupEventsWithoutBrowserControl(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	epoch := *f.data.Session.SourceEpoch
	oldID, newID := uuid.NewString(), uuid.NewString()
	native := "native"
	seq := 0
	emit := func(kind string, payload any) {
		t.Helper()
		seq++
		ctx = f.dao.ContextPhase(ctx, map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1, "TouchSession": 1, "SaveSession": 1})
		_, e := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(int64(seq)), Kind: kind, Payload: encode(payload)}}})
		f.dao.FinishContext(ctx)
		if e != nil {
			t.Fatal(e)
		}
		selectContentHandle(t, f)
	}
	entry := func(id string) map[string]any {
		return map[string]any{"entryId": id, "revision": "1", "kind": "interaction", "interaction": map[string]any{"interactionId": id, "revision": "1", "state": "pending", "title": "Approve", "kind": "approval", "detail": "cleanup", "actions": []string{"allow_once", "reject"}}}
	}
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "waiting_input", Capabilities: sp.Capabilities{Send: true, Respond: true}}
	emit("state", state)
	emit("timeline_upsert", entry(oldID))
	draining := *f.data.Session
	draining.Snapshot.Lifecycle = "draining"
	until, watermark := f.s.now().Add(time.Minute), number(draining.Snapshot.LastTimelineSeq)
	draining.DrainUntil, draining.DrainTimelineSeq = &until, &watermark
	f.data.Session = &draining
	emit("timeline_upsert", entry(newID))
	state.CleanupInteractionIDs = []string{newID}
	emit("state", state)
	ctx = f.BrowserPhase(ctx, mergeFixtureCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, nil))
	snapshot, _, _, e := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	f.dao.FinishContext(ctx)
	if e != nil || snapshot.Operations.CanRespond || snapshot.Operations.CanSend || snapshot.Operations.CanCancel {
		t.Fatal("draining permissions", snapshot, e)
	}
	if _, e = sp.DecodeSnapshot(encode(snapshot)); e != nil {
		t.Fatal("draining codec", e)
	}
	response := func(id string) sp.Command {
		return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "reply", OperationID: uuid.NewString(), Kind: "interaction_response", Payload: encode(sp.InteractionResponse{InteractionID: id, InteractionRevision: "1", SubmissionID: uuid.NewString(), Response: json.RawMessage(`{"kind":"approval","action":"allow_once"}`)})}
	}
	ctx = f.BrowserPhase(ctx, mergeFixtureCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, map[string]int{"SessionOperation": 1}))
	if _, e = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, response(oldID)); e == nil {
		t.Fatal("old pending response")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, mergeFixtureCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, map[string]int{"SessionOperation": 1}))
	if _, e = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, response(newID)); e == nil {
		t.Fatal("draining browser cleanup response accepted")
	}
	f.dao.FinishContext(ctx)
	ctx = f.dao.ContextPhase(ctx, map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1, "AcceptedSessionOperations": 1})
	offers, e := f.s.Poll(ctx, v.ControllerFence)
	f.dao.FinishContext(ctx)
	if e != nil || len(offers) != 0 {
		t.Fatal("draining control offer", offers, e)
	}
	// A stale old request cannot become cleanup merely by being included in state.
	state.CleanupInteractionIDs = []string{oldID}
	seq++
	ctx = f.dao.ContextPhase(ctx, map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(int64(seq)), Kind: "state", Payload: encode(state)}}}); e == nil {
		t.Fatal("old interaction relabelled cleanup")
	}
	f.dao.FinishContext(ctx)
}

func TestTestSessionNeverStartedStopRequiresUntouchedExecution(t *testing.T) {
	f := standaloneTestFixture(t)
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "InsertTestSession": 1})
	v, e := f.s.RegisterTest(ctx, f.p, registration)
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectRegistrationWrite(t)
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	if _, e = sp.DecodeTestStop(encode(stop)); e != nil {
		t.Fatal("never started codec", e)
	}
	ctx = f.BrowserPhase(ctx, map[string]int{"StoppingTestOperations": 1, "SetTestSessionStop": 1, "SaveSession": 1})
	archived, e := f.s.StopTest(ctx, f.p, v.SessionID, stop)
	f.dao.FinishContext(ctx)
	if e != nil || archived.Lifecycle != "archived" {
		t.Fatal("untouched archive", archived, e)
	}
	f.SelectSessionWrite(t)
	f.data.Session.StopProof = append([]byte(nil), f.writes.StopProof...)
	ctx = f.BrowserPhase(ctx, nil)
	if _, e = f.s.StopTest(ctx, f.p, v.SessionID, stop); e != nil {
		t.Fatal("never started retry", e)
	}
	f.dao.FinishContext(ctx)
	connected, cv, _ := testSession(t, "none")
	stop.Fence = cv.Fence
	stop.ControllerID = cv.Identity.ControllerID
	stop.ControllerInstanceID = cv.Identity.ControllerInstanceID
	stop.StopProof.PreviousControllerInstanceID = cv.Identity.ControllerInstanceID
	ctx = connected.BrowserPhase(ctx, nil)
	if _, e = connected.s.StopTest(ctx, connected.p, cv.SessionID, stop); e == nil {
		t.Fatal("connected masqueraded never started")
	}
	connected.dao.FinishContext(ctx)
	ctx = connected.ControllerPhase(ctx, map[string]int{"DisconnectSession": 1, "SaveSession": 1})
	if e = connected.s.Disconnect(ctx, cv.ControllerFence); e != nil {
		t.Fatal(e)
	}
	connected.dao.FinishContext(ctx)
	connected.SelectDisconnectWrite(t)
	connected.SelectSessionWrite(t)
	ctx = connected.BrowserPhase(ctx, nil)
	if _, e = connected.s.StopTest(ctx, connected.p, cv.SessionID, stop); e == nil {
		t.Fatal("disconnected masqueraded never started")
	}
	connected.dao.FinishContext(ctx)
}
func TestTestSessionUnknownFirstInputCannotReplayUnderANewOperation(t *testing.T) {
	f, v, epoch := testSession(t, "none")
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	ctx = f.ControllerPhase(ctx, map[string]int{"TouchSession": 1, "SaveSession": 1})
	if _, e := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	selectContentHandle(t, f)
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"once"}],"expectedTurnId":null}`)}
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	receipt, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, command)
	f.dao.FinishContext(ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.data.OperationDeadline = f.s.now().Add(30 * time.Second)
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.Session.FirstInputBlocked = true
	f.data.OtherFirstInput = true
	replacement := command
	replacement.OperationID = uuid.NewString()
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "HasOtherFirstInput": 1})
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, replacement); e == nil {
		t.Fatal("duplicate initial operation")
	}
	f.dao.FinishContext(ctx)
	f.data.AcceptedIDs = []string{command.OperationID}
	f.data.OtherFirstInput = false
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 4, "AcceptedSessionOperations": 1, "SessionOperation": 1, "HasOtherFirstInput": 1, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
	if _, e = f.s.Poll(ctx, v.ControllerFence); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	selectContentOffer(t, f)
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 4, "SessionOperation": 1, "HasOtherFirstInput": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	receipt.State = "unknown"
	ctx = f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); e != nil {
		t.Fatal(e)
	}
	f.dao.FinishContext(ctx)
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	ctx = f.BrowserPhase(ctx, nil)
	snapshot, e := f.s.TestSnapshot(ctx, f.p, v.SessionID)
	f.dao.FinishContext(ctx)
	if e != nil || snapshot.Operations.CanSend {
		t.Fatal("unknown first input writable", e)
	}
	f.data.OtherFirstInput = true
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "HasOtherFirstInput": 1})
	if _, e = f.s.Submit(ctx, f.p, "", "", v.SessionID, replacement); e == nil {
		t.Fatal("unknown first input replayed")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1})
	retry, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, command)
	f.dao.FinishContext(ctx)
	if e != nil || retry.State != "unknown" {
		t.Fatal("same operation reconciliation", retry, e)
	}
}

func TestTestSessionStopPreservesUncertainEffectsAndRejectsBadProofs(t *testing.T) {
	f, v, epoch := testSession(t, "prompt")
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	ctx = f.ControllerPhase(ctx, map[string]int{"TouchSession": 1, "SaveSession": 1})
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(ctx)
	selectContentHandle(t, f)
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"once"}],"expectedTurnId":null}`)}
	neverOffered := command
	neverOffered.OperationID = uuid.NewString()
	responses := configureContentOperations(t, f, command, neverOffered)
	f.dao.StoppingTestOperationsFn = func(_ context.Context, id string) ([]string, error) {
		if id != v.SessionID {
			t.Fatal("unexpected stop Session")
		}
		return []string{command.OperationID, neverOffered.OperationID}, nil
	}
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, command); err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(ctx)
	responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
	f.SelectSessionWrite(t)
	responses.accepted = []string{command.OperationID}
	ctx = f.ControllerPhase(ctx, map[string]int{"LockCredential": 4, "AcceptedSessionOperations": 1, "SessionOperation": 1, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(ctx)
	responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
	f.SelectSessionWrite(t)
	responses.accepted = nil
	responses.pending = 1
	ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, neverOffered); err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(ctx)
	responses.useProposedResponse(neverOffered.OperationID, f.s.now().Add(time.Minute))
	f.SelectSessionWrite(t)
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	bad := stop
	bad.ControllerInstanceID = uuid.NewString()
	ctx = f.BrowserPhase(ctx, nil)
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("wrong instance proof")
	}
	f.dao.FinishContext(ctx)
	bad = stop
	bad.StopProof.StoppedAt = time.Now().Add(time.Hour).Format(time.RFC3339Nano)
	ctx = f.BrowserPhase(ctx, nil)
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("future stop proof")
	}
	f.dao.FinishContext(ctx)
	login := f.p
	login.Kind = model.SessionCredential
	ctx = f.dao.ContextPhase(ctx, map[string]int{})
	if _, err := f.s.StopTest(ctx, login, v.SessionID, stop); err == nil {
		t.Fatal("browser submitted OS proof")
	}
	f.dao.FinishContext(ctx)
	ctx = f.BrowserPhase(ctx, map[string]int{"StoppingTestOperations": 1, "SessionOperation": 2, "SetSessionOperationReceipt": 2, "SetTestSessionStop": 1, "SaveSession": 1})
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, stop); err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(ctx)
	responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
	responses.useProposedResponse(neverOffered.OperationID, f.s.now().Add(time.Minute))
	f.SelectSessionWrite(t)
	f.data.Session.StopProof = append([]byte(nil), f.writes.StopProof...)
	for id, want := range map[string]string{command.OperationID: "unknown", neverOffered.OperationID: "rejected"} {
		ctx = f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1})
		receipt, err := f.s.Operation(ctx, f.p, "", "", v.SessionID, id)
		f.dao.FinishContext(ctx)
		if err != nil || receipt.State != want {
			t.Fatal("stop invented receipt", receipt, err)
		}
	}
	bad = stop
	bad.StopProof.RecordID = uuid.NewString()
	ctx = f.BrowserPhase(ctx, nil)
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, bad); err == nil {
		t.Fatal("conflicting proof retry")
	}
	f.dao.FinishContext(ctx)
}

func TestTestRegistrationRefusesBrowserAndExpiredCredentials(t *testing.T) {
	f := standaloneTestFixture(t)
	ctx := context.Background()
	defer func() { f.dao.FinishContext(ctx) }()
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	browser := f.p
	browser.Kind = model.SessionCredential
	ctx = f.dao.ContextPhase(ctx, map[string]int{})
	if _, err := f.s.RegisterTest(ctx, browser, input); err == nil {
		t.Fatal("browser registration admitted")
	}
	f.dao.FinishContext(ctx)
	refusal := &model.Fault{Code: "unauthenticated", Message: "Credential is expired."}
	f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
		if p != f.p {
			t.Fatalf("unexpected credential %+v", p)
		}
		return refusal
	}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1})
	if _, err := f.s.RegisterTest(ctx, f.p, input); err != refusal {
		t.Fatal("expired credential registration admitted")
	}
	f.dao.FinishContext(ctx)
	if f.writes.Registration != nil || f.data.Session != nil {
		t.Fatal("refused registration proposed a Session")
	}
}
