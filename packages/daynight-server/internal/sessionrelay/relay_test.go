package sessionrelay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

type fixture struct {
	s             *Service
	p             core.Principal
	project, task string
	r             sp.Registration
}

func connectFixture(t *testing.T) (fixture, sp.Snapshot) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	v, e := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if e != nil {
		t.Fatal(e)
	}
	g, e := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if e != nil {
		t.Fatal(e)
	}
	v, e = f.s.Connect(ctx, g.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	synchronizeFixture(t, f, v)
	return f, v
}
func TestDurableEventsDeduplicationAndOperationDispatch(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	var epoch string
	if e := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); e != nil {
		t.Fatal(e)
	}
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	msg := sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}
	if _, e := f.s.Handle(ctx, msg); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.Handle(ctx, msg); e != nil {
		t.Fatal(e)
	}
	state.Activity = "working"
	changed := msg
	changed.Events = []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}
	if _, e := f.s.Handle(ctx, changed); e == nil {
		t.Fatal("source sequence collision accepted")
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	receipt, e := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command)
	if e != nil || receipt.State != "accepted" {
		t.Fatalf("submit %#v %v", receipt, e)
	}
	command.RequestID = "retry"
	if _, e = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command); e != nil {
		t.Fatal("request ID changed stable intent", e)
	}
	offers, e := f.s.Poll(ctx, v.ControllerFence)
	if e != nil || len(offers) != 1 {
		t.Fatalf("offer %#v %v", offers, e)
	}
	if again, e := f.s.Poll(ctx, v.ControllerFence); e != nil || len(again) != 0 {
		t.Fatal("offered operation replayed", e)
	}
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); e != nil {
		t.Fatal(e)
	}
	receipt.State = "confirmed"
	if _, e = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); e != nil {
		t.Fatal(e)
	}
	got, e := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, command.OperationID)
	if e != nil || got.State != "confirmed" {
		t.Fatalf("receipt %#v %v", got, e)
	}
}

func TestHistoryResourceReadsRemainBoundToTheCurrentClaim(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	syncContent(t, f, v)
	var epoch string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	entry := map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Saved history"}}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: encode(entry)}}}); err != nil {
		t.Fatal(err)
	}
	read := readPage(ctx, f, v, "tail", "", 10)
	request := nextContent(t, f, v)
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string), localEntry(t, "1")), nil)
	got := <-read
	if got.err != nil || len(got.page["items"].([]sp.TimelineEntry)) != 1 {
		t.Fatalf("local history %#v %v", got.page, got.err)
	}

	snapshot, events, cursor, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil || len(events) != 0 || cursor == "" {
		t.Fatalf("initial stream %v", err)
	}
	if snapshot.LastTimelineSeq != "1" {
		t.Fatal("snapshot omitted history watermark")
	}
	bad := snapshot
	bad.HistoryEpoch = uuid.NewString()
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, EventCursor(bad, "0")); err == nil {
		t.Fatal("foreign cursor accepted")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, cursor); err == nil {
		t.Fatal("revoked member retained event access")
	}
}

func setup(t *testing.T) fixture {
	t.Helper()
	ctx := context.Background()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("isolated database required")
	}
	pool, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	schema := "relay_" + strings.ToLower(rand.Text())
	if _, err = pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, e := pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		if e != nil {
			t.Error(e)
		}
		pool.Close()
	})
	u, _ := url.Parse(raw)
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := store.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	f := fixture{s: New(db), p: core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, project: uuid.NewString(), task: uuid.NewString()}
	f.r = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	properties, err := taskproperties.WithWorker(core.TaskProperties{}, &core.WorkerClaim{ClaimID: f.r.ClaimID, UserID: f.p.UserID, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, State: core.WorkerActive, Agent: core.AgentCodex, AgentControlMode: core.AgentControlModeWeb, Machine: core.WorkerMachine{ID: uuid.NewString(), Name: "test"}, Platform: core.PlatformLinux, Phase: core.WorkerExecuting, ClaimedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("fixture"))
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now())`, []any{f.p.UserID}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'relay',now(),now()+interval '1 day')`, []any{f.p.CredentialID, f.p.UserID, hash[:]}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Relay','https://github.com/example/relay.git')`, []any{f.project}},
		{`INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.project, f.p.UserID}},
		{`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Relay','in_progress')`, []any{f.task, f.project}},
		{`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, []any{f.task, string(properties["worker"])}},
	} {
		if _, err = db.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	return f
}
func TestRegistrationIsIdempotentAndGrantCannotCreateAnotherNativeIdentity(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	a, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if err != nil || a.SessionID != b.SessionID || a.ConnectionEpoch != "0" || a.Operations.CanSend {
		t.Fatalf("registration: %#v %v", b, err)
	}
	changed := f.r
	changed.ControllerID = uuid.NewString()
	if _, err = f.s.Register(ctx, f.p, f.project, f.task, changed); err == nil {
		t.Fatal("conflicting registration accepted")
	}
	grant, err := f.s.Grant(ctx, f.p, f.project, f.task, a.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: a.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil || grant.Token == "" {
		t.Fatalf("grant: %v", err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: a.Fence}, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connected, err := f.s.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil || connected.ConnectionEpoch != "1" {
		t.Fatalf("connect: %#v %v", connected, err)
	}
	if _, err = f.s.Connect(ctx, grant.Token, hello, uuid.NewString()); err == nil {
		t.Fatal("bootstrap replay")
	}
}

func TestClaimCompletionFreezesSessionInTheTaskTransaction(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	command := submitText(t, f, v)
	claim := v.ClaimID
	if _, err := service.NewTasks(f.s.DB).SetStatus(ctx, f.p, f.project, f.task, service.SetTaskStatus{Version: 1, Status: core.TaskDone, ClaimID: &claim}); err != nil {
		for errors.Unwrap(err) != nil {
			err = errors.Unwrap(err)
		}
		t.Fatal(err)
	}
	current, err := f.s.Current(ctx, f.p, f.project, f.task)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := current["session"].(sp.Snapshot)
	if snapshot.Lifecycle != "draining" || snapshot.Operations.CanSend {
		t.Fatalf("claim ended without freezing session: %#v", snapshot)
	}
	operation, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || operation.State != "rejected" {
		t.Fatal("undispatched operation survived ended claim", operation.State, err)
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err != nil {
		t.Fatal("draining final upload window rejected", err)
	}
	f.s.now = func() time.Time { return time.Now().Add(61 * time.Second) }
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err == nil {
		t.Fatal("expired draining connection accepted")
	}
	if _, err = f.s.Current(ctx, f.p, f.project, f.task); err != nil {
		t.Fatal(err)
	}
	var lifecycle string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&lifecycle); err != nil || lifecycle != "archived" {
		t.Fatal("expired drain was not durably archived", lifecycle, err)
	}
}

func publishState(t *testing.T, f fixture, v sp.Snapshot, state sp.State) {
	t.Helper()
	ctx := context.Background()
	var epoch string
	var seq int64
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text,last_source_seq FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch, &seq); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: decimal(seq + 1), Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal(err)
	}
}
func idleState() sp.State {
	native := "native"
	return sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Steer: true, Cancel: true, Respond: true}}
}
func submitText(t *testing.T, f fixture, v sp.Snapshot) sp.Command {
	t.Helper()
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	if _, err := f.s.Submit(context.Background(), f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	return c
}
func reconnect(t *testing.T, f fixture, v sp.Snapshot) sp.Snapshot {
	t.Helper()
	ctx := context.Background()
	g, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	var epoch string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	out, err := f.s.Connect(ctx, g.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestReconnectNeverReplaysAnOfferWithoutJournalEvidence(t *testing.T) {
	for _, journal := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing_journal", true: "not_submitted"}[journal], func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			publishState(t, f, v, idleState())
			c := submitText(t, f, v)
			if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
				t.Fatal(err)
			}
			newV := reconnect(t, f, v)
			if _, err := f.s.Poll(ctx, v.ControllerFence); err == nil {
				t.Fatal("old connection survived CAS")
			}
			items := []sp.Reconciliation{}
			if journal {
				items = append(items, sp.Reconciliation{OperationID: c.OperationID, State: "not_submitted"})
			}
			if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "reconcile", Final: true, ControllerFence: newV.ControllerFence, Operations: items}); err != nil {
				t.Fatal(err)
			}
			receipt, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, c.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			want := "unknown"
			if journal {
				want = "rejected"
			}
			if receipt.State != want {
				t.Fatalf("reconciled %s, expected %s", receipt.State, want)
			}
			publishState(t, f, newV, idleState())
			offers, err := f.s.Poll(ctx, newV.ControllerFence)
			if err != nil {
				t.Fatal(err)
			}
			if len(offers) != 0 {
				t.Fatal("unsafe replay or lost proven unsubmitted operation")
			}
		})
	}
}

func TestForcedWorkerWithdrawalFreezesWebSessionWithoutStopClaim(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	command := submitText(t, f, v)
	task, err := service.NewTasks(f.s.DB).WithdrawWorker(ctx, f.p, f.project, f.task, service.WithdrawWorker{Version: 1, ClaimID: v.ClaimID})
	if _, present := task.Properties["worker"]; err != nil || present || task.AllowAgents || task.Status != core.TaskTodo {
		t.Fatal("withdrawal retained ownership", task, err)
	}
	var raw []byte
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snapshot sp.Snapshot
	err = json.Unmarshal(raw, &snapshot)
	if err != nil || snapshot.Lifecycle != "draining" || snapshot.Activity == "stopped" {
		t.Fatal("withdrawal did not fence without claiming stop", snapshot, err)
	}
	var receiptState string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT receipt->>'state' FROM session_operations WHERE session_id=$1 AND operation_id=$2`, v.SessionID, command.OperationID).Scan(&receiptState); err != nil || receiptState != "rejected" {
		t.Fatal("undispatched operation survived withdrawal", receiptState, err)
	}
	if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command); err == nil {
		t.Fatal("withdrawn claim accepted input")
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err != nil {
		t.Fatal("withdrawal discarded final observation window", err)
	}
}

func synchronizeFixture(t *testing.T, f fixture, v sp.Snapshot) {
	t.Helper()
	state := sp.State{NativeSessionID: v.Identity.NativeSessionID, InitialInputState: v.InitialInputState, Synchronized: true, Activity: "initializing"}
	if _, err := f.s.Handle(context.Background(), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
}

func TestSessionReadsRejectInvalidStoredProperties(t *testing.T) {
	for _, input := range []struct {
		name  string
		value string
	}{
		{name: "worker", value: "null"},
		{name: "pullRequests", value: "["},
		{name: "pullRequests", value: "null"},
		{name: "unknown", value: "{}"},
	} {
		t.Run(input.name+"/"+input.value, func(t *testing.T) {
			f := setup(t)
			ctx := context.Background()
			if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3) ON CONFLICT(task_id,name) DO UPDATE SET value=excluded.value`, f.task, input.name, input.value); err != nil {
				t.Fatal(err)
			}
			_, err := f.s.Current(ctx, f.p, f.project, f.task)
			var invalid *taskproperties.ValidationError
			if !errors.As(err, &invalid) {
				t.Fatalf("stored property did not retain validation error: %v", err)
			}
		})
	}
}
