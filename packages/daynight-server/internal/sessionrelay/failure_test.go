package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func addMember(t *testing.T, f fixture, role string) core.Principal {
	t.Helper()
	p := core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(p.CredentialID))
	ctx := context.Background()
	for _, q := range []struct {
		sql  string
		args []any
	}{{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now())`, []any{p.UserID}}, {`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'member',now(),now()+interval '1 day')`, []any{p.CredentialID, p.UserID, hash[:]}}, {`INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)`, []any{f.project, p.UserID, role}}} {
		if _, err := f.s.DB.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return p
}
func TestReadOnlyMembersAndRevokedActorsCannotDispatch(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	reader := addMember(t, f, "member")
	admin := addMember(t, f, "admin")
	current, err := f.s.Current(ctx, reader, f.project, f.task)
	if err != nil || current["session"].(sp.Snapshot).Operations.CanSend {
		t.Fatal("reader obtained native permission", err)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "member", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	if _, err = f.s.Submit(ctx, reader, f.project, f.task, v.SessionID, command); err == nil {
		t.Fatal("reader submitted native input")
	}
	if _, err = f.s.Submit(ctx, admin, f.project, f.task, v.SessionID, command); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command); err == nil {
		t.Fatal("another actor reused operation identity")
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, admin.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); err == nil {
		t.Fatal("revoked admin passed native call fence")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, admin.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err = f.s.controller(ctx, v.ControllerFence, func(tx pgx.Tx, r *record, task task) error {
		o, e := loadOperation(ctx, tx, v.SessionID, command.OperationID)
		if e != nil {
			return e
		}
		return f.s.operationAuthorized(ctx, tx, r, task, o)
	}); err == nil {
		t.Fatal("revoked operation credential accepted")
	}
	wrong := command
	wrong.OperationID = uuid.NewString()
	wrong.SessionID = uuid.NewString()
	if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, wrong); err == nil {
		t.Fatal("cross session command")
	}
	if _, err = f.s.Current(ctx, f.p, uuid.NewString(), f.task); err == nil {
		t.Fatal("cross project lookup")
	}
	if _, err = f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString()); err == nil {
		t.Fatal("unknown operation returned")
	}
	if _, err = f.s.Grant(ctx, reader, f.project, f.task, v.SessionID, sp.Grant{}); err == nil {
		t.Fatal("reader minted controller grant")
	}
	cookie := reader
	cookie.Kind = core.SessionCredential
	if _, err = f.s.Register(ctx, cookie, f.project, f.task, f.r); err == nil {
		t.Fatal("cookie registered worker")
	}
	if _, err = f.s.Grant(ctx, cookie, f.project, f.task, v.SessionID, sp.Grant{}); err == nil {
		t.Fatal("cookie minted controller grant")
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "unsupported", ControllerFence: v.ControllerFence}); err == nil {
		t.Fatal("unsupported controller method")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("revoked parent grant remained active")
	}
}
func TestMalformedAndConflictingEventsRollBackWithoutAdvancingWatermarks(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	entryID := uuid.NewString()
	entry := map[string]any{"entryId": entryID, "revision": "2", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "hello"}}}
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}))
	for _, event := range []sp.SourceEvent{{Kind: "state", Payload: json.RawMessage(`{}`)}, {Kind: "timeline_upsert", Payload: json.RawMessage(`{}`)}, {Kind: "resource", Payload: json.RawMessage(`{}`)}, {Kind: "unsupported", Payload: json.RawMessage(`{}`)}, {Kind: "gap", Payload: json.RawMessage(`invalid`)}} {
		if _, err := f.s.Handle(ctx, source(t, f, v, event)); err == nil {
			t.Fatal("invalid event persisted", event.Kind)
		}
	}
	entry["revision"] = "1"
	if _, err := f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)})); err == nil {
		t.Fatal("timeline revision regressed")
	}
	entry["revision"] = "2"
	entry["content"] = []any{map[string]any{"type": "text", "text": "different"}}
	if _, err := f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)})); err == nil {
		t.Fatal("same revision different body")
	}
	entry["revision"] = "3"
	batch := source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}, sp.SourceEvent{Kind: "gap", Payload: json.RawMessage(`{"reason":"Native history is unavailable"}`)})
	apply(t, f, batch)
	changed := batch
	changed.Events = changed.Events[:1]
	if _, err := f.s.Handle(ctx, changed); err == nil {
		t.Fatal("batch identity changed")
	}
	missing := source(t, f, v, sp.SourceEvent{Kind: "gap", Payload: json.RawMessage(`{"reason":"gap"}`)})
	missing.Events[0].SourceSeq = "20"
	if _, err := f.s.Handle(ctx, missing); err == nil {
		t.Fatal("source gap silently skipped")
	}
	n, err := f.s.SourceSeq(ctx, v.ControllerFence)
	if err != nil || n != 3 {
		t.Fatal("failed transaction advanced source watermark", n, err)
	}
	oversized := decimal(sp.MaxResourceBytes + 1)
	r := sp.Resource{ResourceID: uuid.NewString(), Status: "pending", Name: "large", ByteLength: &oversized}
	if _, err = f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "resource", Payload: encode(r)})); err == nil {
		t.Fatal("oversize resource declaration")
	}
	if jsonEqual([]byte("invalid"), []byte("invalid")) {
		t.Fatal("invalid journal compared equal")
	}
}
func TestReconciliationResolvesJournalFactsWithoutReplayingDispatching(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	commands := []sp.Command{}
	for range 4 {
		commands = append(commands, submitText(t, f, v))
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	for _, c := range commands[:3] {
		apply(t, f, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID})
	}
	current := reconnect(t, f, v)
	items := []sp.Reconciliation{{OperationID: commands[0].OperationID, State: "dispatching"}, {OperationID: commands[1].OperationID, State: "confirmed"}, {OperationID: commands[2].OperationID, State: "not_submitted"}}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: items, Final: false})
	r, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, commands[3].OperationID)
	if err != nil || r.State != "offered" {
		t.Fatal("unfinished reconciliation consumed absent operation", err)
	}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: []sp.Reconciliation{{OperationID: commands[3].OperationID, State: "unknown"}}, Final: true})
	for i, want := range []string{"unknown", "confirmed", "unknown", "unknown"} {
		got, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, commands[i].OperationID)
		if err != nil || got.State != want {
			t.Fatalf("reconcile %d got %s want %s: %v", i, got.State, want, err)
		}
	}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: items, Final: true})
	publishState(t, f, current, idleState())
	offers, err := f.s.Poll(ctx, current.ControllerFence)
	if err != nil || len(offers) != 0 {
		t.Fatal("uncertain operation replayed", err)
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: []sp.Reconciliation{{OperationID: uuid.NewString(), State: "confirmed"}}, Final: true}); err == nil {
		t.Fatal("unknown journal operation")
	}
}
func TestDatabaseFailuresDoNotBecomeAcknowledgements(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	c := submitText(t, f, v)
	if _, err := f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt storage failure'; END $$; CREATE TRIGGER refuse_receipt BEFORE UPDATE OF receipt ON session_operations FOR EACH ROW EXECUTE FUNCTION refuse_receipt()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("failed durable offer acknowledged")
	}
	var state string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT receipt->>'state' FROM session_operations WHERE operation_id=$1`, c.OperationID).Scan(&state); err != nil || state != "accepted" {
		t.Fatal("failed receipt did not roll back", err)
	}
	f.s.DB.Close()
	if _, err := f.s.Current(ctx, f.p, f.project, f.task); err == nil {
		t.Fatal("closed database read succeeded")
	}
}
func TestExpiredGrantAndForeignCursorFailClosed(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	g, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	var epoch string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "500", SchemaVersion: 1, ProjectionVersion: 1}
	if _, err = f.s.Connect(ctx, g.Token, hello, uuid.NewString()); err == nil {
		t.Fatal("controller claimed uncommitted ACK")
	}
	hello.LastAckedSourceSeq = "0"
	hello.SourceEpoch = uuid.NewString()
	if _, err = f.s.Connect(ctx, g.Token, hello, uuid.NewString()); err == nil {
		t.Fatal("hello silently reset source epoch")
	}
	f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	if _, err = f.s.Connect(ctx, g.Token, hello, uuid.NewString()); err == nil {
		t.Fatal("expired grant")
	}
	if _, err = f.s.PutResource(ctx, g.Token, "1", uuid.NewString(), nil); err == nil {
		t.Fatal("expired resource grant")
	}
	f.s.now = time.Now
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, EventCursor(v, "999")); err == nil {
		t.Fatal("future event cursor")
	}
	if _, err = f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "before", cursor(position{Session: v.SessionID, Epoch: v.HistoryEpoch, Kind: "timeline", Position: "999", Upper: "999"}), 10); err == nil {
		t.Fatal("future timeline cursor")
	}
}

func TestBrowserCatchupAuthorizesEachSnapshotAndRejectsCrossTaskAccess(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	reader := addMember(t, f, "member")
	_, events, _, err := f.s.BrowserPoll(ctx, reader, f.project, f.task, v.SessionID, EventCursor(v, "0"))
	if err != nil || len(events) < 2 {
		t.Fatal("snapshot catchup missing", err)
	}
	for _, event := range events {
		parsed, err := sp.DecodeEvent(encode(event))
		if err != nil {
			t.Fatal("public catchup schema invalid", err)
		}
		_ = parsed
		if event["kind"] == "snapshot" && event["payload"].(sp.Snapshot).Operations.CanSend {
			t.Fatal("historical snapshot granted reader write permission")
		}
	}
	if _, err = f.s.Operation(ctx, f.p, uuid.NewString(), f.task, v.SessionID, uuid.NewString()); err == nil {
		t.Fatal("cross-project operation access")
	}
	if _, err = f.s.Operation(ctx, f.p, f.project, f.task, uuid.NewString(), uuid.NewString()); err == nil {
		t.Fatal("unknown session access")
	}
	wrong := v.ControllerFence
	wrong.SessionID = uuid.NewString()
	if _, err = f.s.Poll(ctx, wrong); err == nil {
		t.Fatal("unknown controller session")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("inactive claim controller")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("deleted task controller")
	}
}

func TestGrantRenewalCannotReplaceTheParentCredentialOfAnExistingConnection(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	replacement := f.p
	replacement.CredentialID = uuid.NewString()
	hash := sha256.Sum256([]byte(replacement.CredentialID))
	if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'renewal',now(),now()+interval '1 day')`, replacement.CredentialID, replacement.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Grant(ctx, replacement, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err == nil {
		t.Fatal("a pending grant revived the revoked old connection")
	}
}
