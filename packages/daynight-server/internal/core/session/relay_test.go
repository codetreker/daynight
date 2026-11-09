package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
	"time"
)

type fixture struct {
	s             *Execution
	writer        *fixtureWriter
	dao           *fixtureDAO
	data          *fixtureData
	writes        *fixtureWrites
	terminal      *terminalFixtureData
	p             model.Principal
	project, task string
	r             sp.Registration
}

func connectFixture(t *testing.T) (fixture, sp.Snapshot) {
	t.Helper()
	f := setup(t)
	now, source := f.s.now(), uuid.NewString()
	expiry := now.Add(2 * time.Minute)
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: f.r.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.project, TaskID: f.task, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "synchronizing", Activity: "initializing"}
	f.data.Session = &store.SessionRecord{Snapshot: snapshot, Owner: f.p.UserID, Parent: f.p.CredentialID, ConnectionParent: f.p.CredentialID, Registration: encode(f.r), ServerInstance: &f.s.instance, SourceEpoch: &source, SourceEpochs: []string{source}, LastSeen: &now, ConnectionExpiry: &expiry, Consumed: true}
	f.data.Location = store.SessionLocation{SessionID: snapshot.SessionID, ProjectID: f.project, TaskID: f.task}
	f.data.LocationError = nil
	f.data.RegistrationID = snapshot.SessionID
	f.data.RegistrationError = nil
	f.data.CurrentSessionID = snapshot.SessionID
	f.data.CurrentSessionError = nil
	live := newLive(snapshot)
	live.LastSeen = &now
	f.s.live[snapshot.SessionID] = &liveCell{value: live}
	synchronizeFixture(t, f, snapshot)
	return f, snapshot
}

func TestSourceEventsDeduplicateAndDispatchStableOperations(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	epoch := *f.data.Session.SourceEpoch
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	message := sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}
	for range 2 {
		if _, err := fixtureHandle(f, ctx, message, map[string]int{"TouchSession": 1, "SaveSession": 1}); err != nil {
			t.Fatal(err)
		}
		if f.writes.Session.SourceSeq != 1 {
			t.Fatal("source ACK capture changed deduplicated sequence")
		}
		f.SelectSessionWrite(t)
		f.SelectTouchWrite(t)
	}
	state.Activity = "working"
	changed := message
	changed.Events = []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}
	if _, err := fixtureHandle(f, ctx, changed, nil); err == nil {
		t.Fatal("source sequence collision accepted")
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	receipt, err := fixtureSubmit(f, ctx, f.p, v, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if err != nil || receipt.State != "accepted" {
		t.Fatalf("submit %#v %v", receipt, err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.PendingCount = 1
	f.data.AcceptedIDs = []string{command.OperationID}
	command.RequestID = "retry"
	if _, err = fixtureSubmit(f, ctx, f.p, v, command, map[string]int{"SessionOperation": 1}); err != nil {
		t.Fatal("request ID changed stable intent", err)
	}
	offers, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
	if err != nil || len(offers) != 1 {
		t.Fatalf("offer %#v %v", offers, err)
	}
	if f.writes.Receipt.State != "offered" {
		t.Fatal("offer did not capture offered receipt")
	}
	f.SelectReceiptWrite(t)
	f.SelectEpochWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = nil
	if again, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1}); err != nil || len(again) != 0 {
		t.Fatal("offered operation replayed", err)
	}
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	if f.writes.Receipt.State != "dispatching" {
		t.Fatal("native admission did not capture dispatch state")
	}
	f.SelectReceiptWrite(t)
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
	receipt.State = "confirmed"
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	f.SelectReceiptWrite(t)
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
	got, err := fixtureOperation(f, ctx, v, command.OperationID)
	if err != nil || got.State != "confirmed" {
		t.Fatalf("receipt %#v %v", got, err)
	}
}

func TestHistoryResourceReadsRemainBoundToTheCurrentClaim(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	syncContent(t, f, v)
	epoch := *f.data.Session.SourceEpoch
	entry := map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Saved history"}}}
	if _, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: encode(entry)}}}, map[string]int{"TouchSession": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
	read := readPage(contentReadPhase(f, ctx, 2), f, v, "tail", "", 10)
	request := nextContent(t, f, v)
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string), localEntry(t, "1")), nil)
	got := <-read
	if got.err != nil || len(got.page["items"].([]sp.TimelineEntry)) != 1 {
		t.Fatalf("local history %#v %v", got.page, got.err)
	}

	snapshot, events, cursor, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil || len(events) != 0 || cursor == "" {
		t.Fatalf("initial stream %v", err)
	}
	if snapshot.LastTimelineSeq != "1" {
		t.Fatal("snapshot omitted history watermark")
	}
	bad := snapshot
	bad.HistoryEpoch = uuid.NewString()
	if _, _, _, err = f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, EventCursor(bad, "0")); err == nil {
		t.Fatal("foreign cursor accepted")
	}
	denyFixtureProject(t, f, f.p)
	if _, _, _, err = f.s.BrowserPoll(f.BrowserPhase(ctx, map[string]int{"SessionBotID": 0, "LockSession": 0}), f.p, f.project, f.task, v.SessionID, cursor); err == nil {
		t.Fatal("revoked member retained event access")
	}
}

func setup(t *testing.T) fixture {
	t.Helper()
	f := fixture{p: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, project: uuid.NewString(), task: uuid.NewString()}
	f.r = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.data = &fixtureData{Task: store.SessionTask{Status: "in_progress", Worker: &model.WorkerClaim{ClaimID: f.r.ClaimID, UserID: f.p.UserID, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, Platform: model.PlatformLinux, Phase: model.WorkerExecuting, ClaimedAt: time.Now()}}}
	f.writes = &fixtureWrites{}
	f.data.RegistrationError = model.ErrNotFound
	f.data.CurrentSessionError = model.ErrNotFound
	f.data.LocationError = model.ErrNotFound
	f.data.OperationDeadline = time.Now().Add(30 * time.Second)
	f.dao = newFixtureDAO(t)
	f.writer = &fixtureWriter{dao: f.dao}
	f.writer.WriteFn = f.writer.runFixtureScope
	f.s = New(f.writer)
	configureFixtureData(t, f)
	t.Cleanup(func() {
		if err := f.s.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return f
}

func TestRegistrationIsIdempotentAndGrantCannotCreateAnotherNativeIdentity(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	initialCtx := f.RegistrationPhase(ctx, map[string]int{"InsertTaskSession": 1})
	a, err := f.s.Register(initialCtx, f.p, f.project, f.task, f.r)
	f.dao.FinishContext(initialCtx)
	if err != nil {
		t.Fatal(err)
	}
	if f.writes.Registration == nil || f.writes.Registration.RegistrationID != f.r.RegistrationID || f.writes.Registration.ClaimID != f.r.ClaimID {
		t.Fatal("registration did not preserve claim and retry identity")
	}
	f.SelectRegistrationWrite(t)
	retryCtx := f.RegistrationPhase(ctx, map[string]int{"SessionBotID": 1, "LockSession": 1})
	b, err := f.s.Register(retryCtx, f.p, f.project, f.task, f.r)
	f.dao.FinishContext(retryCtx)
	if err != nil || a.SessionID != b.SessionID || a.ConnectionEpoch != "0" || a.Operations.CanSend {
		t.Fatalf("registration %#v %v", b, err)
	}
	changed := f.r
	changed.ControllerID = uuid.NewString()
	collisionCtx := f.RegistrationPhase(ctx, map[string]int{"SessionBotID": 1, "LockSession": 1})
	_, err = f.s.Register(collisionCtx, f.p, f.project, f.task, changed)
	f.dao.FinishContext(collisionCtx)
	if err == nil {
		t.Fatal("conflicting registration accepted")
	}
	grantCtx := f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	grant, err := f.s.Grant(grantCtx, f.p, f.project, f.task, a.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: a.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	f.dao.FinishContext(grantCtx)
	if err != nil || grant.Token == "" {
		t.Fatalf("grant %v", err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: a.Fence}, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connectCtx := f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1})
	connected, err := f.s.Connect(connectCtx, grant.Token, hello, uuid.NewString())
	f.dao.FinishContext(connectCtx)
	if err != nil || connected.ConnectionEpoch != "1" {
		t.Fatalf("connect %#v %v", connected, err)
	}
	f.SelectConnectionWrite(t)
	replayCtx := f.GrantPhase(ctx, nil)
	_, err = f.s.Connect(replayCtx, grant.Token, hello, uuid.NewString())
	f.dao.FinishContext(replayCtx)
	if err == nil {
		t.Fatal("bootstrap replay")
	}
}

func TestCompletedClaimProjectsFrozenSessionAndExpiresDrain(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	command := submitText(t, f, v)
	f.data.Task.Status = "done"
	f.data.Task.Worker.State = model.WorkerCompleted
	f.data.Session.Snapshot.Lifecycle = "draining"
	until := f.s.now().Add(time.Minute)
	f.data.Session.DrainUntil = &until
	f.data.Operation.Receipt.State = "rejected"
	current, err := f.s.Current(f.TaskPhase(ctx, map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}), f.p, f.project, f.task)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := current["session"].(sp.Snapshot)
	if snapshot.Lifecycle != "draining" || snapshot.Operations.CanSend {
		t.Fatalf("ended claim did not freeze Session: %#v", snapshot)
	}
	operation, err := fixtureOperation(f, ctx, v, command.OperationID)
	if err != nil || operation.State != "rejected" {
		t.Fatal("undispatched operation survived ended claim", operation.State, err)
	}
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}, map[string]int{"TouchSession": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	now := f.s.now()
	f.s.now = func() time.Time { return now.Add(61 * time.Second) }
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}, nil); err == nil {
		t.Fatal("expired draining connection accepted")
	}
	if _, err = f.s.Current(f.TaskPhase(ctx, map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1, "SaveSession": 1}), f.p, f.project, f.task); err != nil {
		t.Fatal(err)
	}
	if f.writes.Session == nil || f.writes.Session.Snapshot.Lifecycle != "archived" {
		t.Fatal("expired drain was not proposed for archival")
	}
}

func publishState(t *testing.T, f fixture, v sp.Snapshot, state sp.State) {
	t.Helper()
	ctx := f.ControllerPhase(context.Background(), map[string]int{"TouchSession": 1, "SaveSession": 1})
	defer f.dao.FinishContext(ctx)
	epoch, seq := *f.data.Session.SourceEpoch, f.data.Session.SourceSeq
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(seq + 1), Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
}
func idleState() sp.State {
	native := "native"
	return sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Steer: true, Cancel: true, Respond: true}}
}
func submitText(t *testing.T, f fixture, v sp.Snapshot) sp.Command {
	t.Helper()
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	ctx := f.BrowserPhase(context.Background(), map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	defer f.dao.FinishContext(ctx)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.PendingCount = 1
	f.data.AcceptedIDs = []string{c.OperationID}
	return c
}
func reconnect(t *testing.T, f fixture, v sp.Snapshot) sp.Snapshot {
	t.Helper()
	ctx := context.Background()
	grantCtx := f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	defer f.dao.FinishContext(grantCtx)
	g, err := f.s.Grant(grantCtx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	epoch := *f.data.Session.SourceEpoch
	connectCtx := f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1})
	defer f.dao.FinishContext(connectCtx)
	out, err := f.s.Connect(connectCtx, g.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	f.SelectConnectionWrite(t)
	return out
}
func TestReconnectNeverReplaysAnOfferWithoutJournalEvidence(t *testing.T) {
	for _, journal := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing_journal", true: "not_submitted"}[journal], func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			publishState(t, f, v, idleState())
			command := submitText(t, f, v)
			if offers, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}); err != nil || len(offers) != 1 {
				t.Fatal("initial offer", offers, err)
			}
			f.SelectReceiptWrite(t)
			f.SelectEpochWrite(t)
			f.SelectSessionWrite(t)
			f.data.AcceptedIDs = nil
			next := reconnect(t, f, v)
			if _, err := fixturePoll(f, ctx, v.ControllerFence, nil); err == nil {
				t.Fatal("old connection survived CAS")
			}
			items := []sp.Reconciliation{}
			counts := map[string]int{"UnreconciledSessionOperations": 1, "SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}
			if journal {
				items = append(items, sp.Reconciliation{OperationID: command.OperationID, State: "not_submitted"})
				counts["LockCredential"], counts["ProjectAccess"], counts["SetSessionOperationEpoch"] = 2, 2, 1
				f.data.UnreconciledIDs = nil
			} else {
				f.data.UnreconciledIDs = []string{command.OperationID}
			}
			if _, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "reconcile", Final: true, ControllerFence: next.ControllerFence, Operations: items}, counts); err != nil {
				t.Fatal(err)
			}
			want := "unknown"
			if journal {
				want = "rejected"
			}
			if f.writes.Receipt == nil || f.writes.Receipt.State != want {
				t.Fatalf("reconciliation capture %#v, expected %s", f.writes.Receipt, want)
			}
			f.SelectReceiptWrite(t)
			f.SelectSessionWrite(t)
			f.SelectTouchWrite(t)
			if journal {
				f.SelectEpochWrite(t)
			}
			f.data.UnreconciledIDs = nil
			f.data.UnreconciledCount = 0
			receipt, err := fixtureOperation(f, ctx, v, command.OperationID)
			if err != nil || receipt.State != want {
				t.Fatalf("reconciled %s, expected %s: %v", receipt.State, want, err)
			}
			synchronizeFixture(t, f, next)
			publishState(t, f, next, idleState())
			offers, err := fixturePoll(f, ctx, next.ControllerFence, map[string]int{"AcceptedSessionOperations": 1})
			if err != nil || len(offers) != 0 {
				t.Fatal("unsafe operation replay after reconnect", offers, err)
			}
		})
	}
}

func TestWithdrawnClaimKeepsFinalObservationWithoutBrowserControl(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	command := submitText(t, f, v)
	f.data.Task.Worker = nil
	f.data.Task.Status = "todo"
	f.data.Session.Snapshot.Lifecycle = "draining"
	until := f.s.now().Add(time.Minute)
	f.data.Session.DrainUntil = &until
	phase := f.TaskPhase(ctx, nil)
	current, err := f.s.Current(phase, f.p, f.project, f.task)
	f.dao.FinishContext(phase)
	if err != nil || current["status"] != "not_applicable" {
		t.Fatal("withdrawn claim remained current", current, err)
	}
	if _, err := fixtureSubmit(f, ctx, f.p, v, command, nil); err == nil {
		t.Fatal("withdrawn claim accepted input")
	}
	output, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}, map[string]int{"TouchSession": 1, "SaveSession": 1})
	if err != nil || output["type"] != "heartbeat_ack" {
		t.Fatal("withdrawal discarded final observation window", output, err)
	}
	if f.writes.Session == nil || f.writes.Session.Snapshot.Lifecycle != "draining" {
		t.Fatal("final observation claimed a native stop")
	}
}

func synchronizeFixture(t *testing.T, f fixture, v sp.Snapshot) {
	t.Helper()
	state := sp.State{NativeSessionID: v.Identity.NativeSessionID, InitialInputState: v.InitialInputState, Synchronized: true, Activity: "initializing"}
	ctx := f.ControllerPhase(context.Background(), map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1})
	defer f.dao.FinishContext(ctx)
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
}

func TestSessionReadsRejectInvalidStoredProperties(t *testing.T) {
	for _, input := range []struct{ name, value string }{{"worker", "null"}, {"pullRequests", "["}, {"pullRequests", "null"}, {"unknown", "{}"}} {
		t.Run(input.name+"/"+input.value, func(t *testing.T) {
			f := setup(t)
			_, expected := taskproperties.Normalize(model.TaskProperties{input.name: json.RawMessage(input.value)})
			if expected == nil {
				t.Fatal("invalid property fixture accepted")
			}
			f.dao.LockTaskFn = func(context.Context, string, string) (store.SessionTask, error) { return store.SessionTask{}, expected }
			f.dao.Expect("LockTask", 1)
			_, err := f.s.Current(f.dao.ContextPhase(context.Background(), map[string]int{"LockTask": 1}), f.p, f.project, f.task)
			if !errors.Is(err, expected) {
				t.Fatalf("DAO property failure lost cause: %v", err)
			}
		})
	}
}
