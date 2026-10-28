package sessionrelay

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
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
	next, err := f.s.RegisterTest(ctx, f.p, input)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.s.Grant(ctx, f.p, "", "", next.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: next.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: next.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	if _, err = f.s.Connect(ctx, grant.Token, hello, uuid.NewString()); err == nil {
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
	if _, err = f.s.Connect(ctx, grant.Token, hello, uuid.NewString()); err == nil {
		stale.mu.Unlock()
		t.Fatal("evicted content owned by an active transaction")
	}
	stale.mu.Unlock()
	if _, err = f.s.Connect(ctx, grant.Token, hello, uuid.NewString()); err != nil {
		t.Fatal("failed admission consumed grant or stale cache was not reclaimed", err)
	}
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
	for range 3 {
		c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "capacity", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: text}}})}
		if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
			t.Fatal(err)
		}
	}
	state := idleState()
	message := sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{pendingEntry(t, uuid.NewString(), "1", strings.Repeat("a", 700_000), "pending"), pendingEntry(t, uuid.NewString(), "1", strings.Repeat("b", 700_000), "pending")}}
	wire, err := sp.DecodeController(encode(message))
	if err != nil {
		t.Fatal("capacity probe must be a valid bounded wire frame", err)
	}
	if _, err = f.s.Handle(ctx, wire); err == nil {
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
	apply(t, f, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{pendingEntry(t, id, "3", "approval", "pending")}})
	if _, err = f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(pendingEntry(t, id, "2", "older", "pending"))})); err == nil {
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
	_, _, old, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	for range 24 {
		apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "reasoning", "text": strings.Repeat("x", 100_000)})}))
	}
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, old); err == nil {
		t.Fatal("evicted event history silently skipped")
	}
	snapshot, _, cursor, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil || cursor == "" || !snapshot.Synchronized {
		t.Fatal("live controller cannot supply a replacement history boundary", err)
	}
	before, err := f.s.SourceSeq(ctx, v.ControllerFence)
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
	if _, err = f.s.Handle(ctx, wire); err == nil {
		t.Fatal("public event exceeded its framed output budget")
	}
	after, err := f.s.SourceSeq(ctx, v.ControllerFence)
	if err != nil || after != before {
		t.Fatal("failed output capacity check advanced source ACK", after, before, err)
	}
}

func TestDisconnectStorageFailurePreservesLeaseAndLiveState(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	if _, err := f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lease write failed'; END $$; CREATE TRIGGER refuse_disconnect BEFORE UPDATE OF connection_expires_at ON task_sessions FOR EACH ROW EXECUTE FUNCTION refuse_disconnect()`); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Disconnect(ctx, v.ControllerFence); err == nil {
		t.Fatal("failed lease revocation reported success")
	}
	current, _, _, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil || !current.Synchronized || current.ConnectionState != "connected" {
		t.Fatal("rollback leaked disconnected memory state", err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DROP TRIGGER refuse_disconnect ON task_sessions; DROP FUNCTION refuse_disconnect()`); err != nil {
		t.Fatal(err)
	}
	if err = f.s.Disconnect(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("revoked connection retained native dispatch permission")
	}
}

func TestReconciliationRechecksRevokedSubmittingCredential(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	actor := addMember(t, f, "admin")
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "revoked", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
	if _, err := f.s.Submit(ctx, actor, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: c.OperationID, State: "not_submitted"}}, Final: true})
	receipt, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, c.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatal("revoked writer's queued input was reauthorized", receipt, err)
	}
}
