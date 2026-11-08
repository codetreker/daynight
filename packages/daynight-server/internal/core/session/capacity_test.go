package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestLiveSessionAdmissionPreservesBusyOwnersAndReclaimsExpiredCache(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	now := time.Now()
	for len(f.s.live) < maxLiveSessions {
		id := uuid.NewString()
		value := newLive(sp.Snapshot{})
		value.LastSeen = &now
		f.s.live[id] = &liveCell{value: value}
	}
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	f.data.Session = nil
	f.data.RegistrationID = ""
	f.data.RegistrationError = model.ErrNotFound
	next, err := f.s.RegisterTest(f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "InsertTestSession": 1}), f.p, input)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectRegistrationWrite(t)
	grant, err := f.s.Grant(f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}), f.p, "", "", next.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: next.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectGrantWrite(t)
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: next.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	if _, err = f.s.Connect(f.GrantPhase(ctx, nil), grant.Token, hello, uuid.NewString()); err == nil {
		t.Fatal("unbounded live admission")
	}
	var staleID string
	for id := range f.s.live {
		if id != v.SessionID {
			staleID = id
			break
		}
	}
	stale := f.s.live[staleID]
	expired := now.Add(-HeartbeatTimeout - time.Second)
	stale.value.LastSeen = &expired
	stale.mu.Lock()
	if _, err = f.s.Connect(f.GrantPhase(ctx, nil), grant.Token, hello, uuid.NewString()); err == nil {
		stale.mu.Unlock()
		t.Fatal("evicted content owned by an active transaction")
	}
	stale.mu.Unlock()
	if _, err = f.s.Connect(f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1}), grant.Token, hello, uuid.NewString()); err != nil {
		t.Fatal("failed admission consumed grant or stale cache was not reclaimed", err)
	}
	f.SelectConnectionWrite(t)
	if len(f.s.live) != maxLiveSessions || f.s.live[staleID] != nil || f.s.live[v.SessionID] == nil {
		t.Fatal("cache eviction crossed the live ownership boundary")
	}
}

func pendingEntry(t *testing.T, id, revision, detail, state string) sp.TimelineEntry {
	t.Helper()
	entry, err := sp.DecodeSourceTimeline(encode(map[string]any{"entryId": id, "entrySeq": "1", "revision": revision, "kind": "interaction", "interaction": map[string]any{"interactionId": id, "revision": revision, "state": state, "title": "Permission", "kind": "approval", "detail": detail, "actions": []string{"allow_once", "reject"}}}))
	if err != nil {
		t.Fatal(err)
	}
	return entry
}
func TestSyncCapacityAndInteractionRegressionRollBackLiveState(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	text := strings.Repeat("x", 1_000_000)
	var commands []sp.Command
	for range 3 {
		c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "capacity", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: text}}})}
		commands = append(commands, c)
	}
	responses := configureContentOperations(t, f, commands...)
	f.dao.Expect("SessionOperation", 3)
	f.dao.Expect("PendingSessionOperationCount", 3)
	f.dao.Expect("InsertSessionOperation", 3)
	for i, c := range commands {
		responses.pending = i
		if _, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, c); err != nil {
			t.Fatal(err)
		}
		f.SelectSessionWrite(t)
		responses.useProposedResponse(c.OperationID, f.s.now().Add(time.Minute))
	}
	state := idleState()
	message := sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{pendingEntry(t, uuid.NewString(), "1", strings.Repeat("a", 700_000), "pending"), pendingEntry(t, uuid.NewString(), "1", strings.Repeat("b", 700_000), "pending")}}
	wire, err := sp.DecodeController(encode(message))
	if err != nil {
		t.Fatal("capacity probe must be a valid bounded wire frame", err)
	}
	if _, err = f.s.Handle(f.ControllerPhase(ctx, nil), wire); err == nil {
		t.Fatal("oversized live state accepted")
	}
	cell := f.s.live[v.SessionID]
	cell.mu.Lock()
	count := len(cell.value.PendingInteractions)
	cell.mu.Unlock()
	if count != 0 {
		t.Fatal("failed synchronization partially replaced pending callbacks")
	}
	id := uuid.NewString()
	apply(t, f, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{pendingEntry(t, id, "3", "approval", "pending")}}, map[string]int{"UnreconciledSessionOperationCount": 1})
	if _, err = f.s.Handle(f.ControllerPhase(ctx, nil), source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(pendingEntry(t, id, "2", "older", "pending"))})); err == nil {
		t.Fatal("stale callback replaced synchronized native state")
	}
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(pendingEntry(t, id, "4", "complete", "resolved"))}))
	cell.mu.Lock()
	count = len(cell.value.PendingInteractions)
	cell.mu.Unlock()
	if count != 0 {
		t.Fatal("resolved callback remained actionable")
	}
}

func TestEventWindowEvictionRequiresLocalHistoryResynchronization(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	_, _, old, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	for range 24 {
		apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "reasoning", "text": strings.Repeat("x", 100_000)})}))
	}
	if _, _, _, err = f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, old); err == nil {
		t.Fatal("evicted event history silently skipped")
	}
	snapshot, _, cursor, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil || cursor == "" || !snapshot.Synchronized {
		t.Fatal("live controller cannot supply a replacement history boundary", err)
	}
	before, err := f.s.SourceSeq(f.ControllerPhase(ctx, nil), v.ControllerFence)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Repeat("x", (sp.MaxFrameBytes-1200)/2)
	message := source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": text}, map[string]any{"type": "text", "text": text}}})})
	message.Protocol = sp.Protocol
	wire, err := sp.DecodeController(encode(message))
	if err != nil {
		t.Fatal("oversize projected event probe must fit inbound frame", len(encode(message)), err)
	}
	if _, err = f.s.Handle(f.ControllerPhase(ctx, nil), wire); err == nil {
		t.Fatal("public event exceeded its framed output budget")
	}
	after, err := f.s.SourceSeq(f.ControllerPhase(ctx, nil), v.ControllerFence)
	if err != nil || after != before {
		t.Fatal("failed output capacity check advanced source ACK", after, before, err)
	}
}

func TestDisconnectStorageFailurePreservesLeaseAndLiveState(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	writeFailure := errors.New("lease write failed")
	disconnect := f.dao.DisconnectSessionFn
	f.dao.DisconnectSessionFn = func(ctx context.Context, sessionID string) error {
		if sessionID != v.SessionID {
			t.Fatalf("disconnect targeted %s", sessionID)
		}
		return writeFailure
	}
	if err := f.s.Disconnect(f.ControllerPhase(ctx, map[string]int{"DisconnectSession": 1}), v.ControllerFence); !errors.Is(err, writeFailure) {
		t.Fatal("failed lease revocation lost its cause", err)
	}
	current, _, _, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil || !current.Synchronized || current.ConnectionState != "connected" {
		t.Fatal("rollback leaked disconnected memory state", err)
	}
	f.dao.DisconnectSessionFn = disconnect
	if err = f.s.Disconnect(f.ControllerPhase(ctx, map[string]int{"DisconnectSession": 1, "SaveSession": 1}), v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	f.SelectDisconnectWrite(t)
	f.SelectSessionWrite(t)
	if _, err = f.s.Poll(f.ControllerPhase(ctx, nil), v.ControllerFence); err == nil {
		t.Fatal("revoked connection retained native dispatch permission")
	}
}

func TestReconciliationRechecksRevokedSubmittingCredential(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	actor := listCredential(t, f, f.p.UserID, model.PATCredential)
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "revoked", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
	if _, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), actor, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = []string{c.OperationID}
	if _, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}), v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	selectContentOffer(t, f)
	revokeContentCredential(t, f, actor)
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: c.OperationID, State: "not_submitted"}}, Final: true}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "UnreconciledSessionOperations": 1})
	f.SelectEpochWrite(t)
	f.SelectReceiptWrite(t)
	receipt, err := f.s.Operation(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, c.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatal("revoked writer's queued input was reauthorized", receipt, err)
	}
}
