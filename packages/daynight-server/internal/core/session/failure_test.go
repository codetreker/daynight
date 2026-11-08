package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func addMember(t *testing.T, f fixture, role string) model.Principal {
	t.Helper()
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	allowFixtureProject(t, f, p, role)
	return p
}

func allowFixtureProject(t *testing.T, f fixture, p model.Principal, role string) {
	t.Helper()
	allowFixtureCredential(t, f, p)
	previous := f.dao.ProjectAccessFn
	f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user == p.UserID {
			if project != f.project {
				t.Fatal("member access changed Project identity")
			}
			grant := model.ProjectGrant{ProjectID: project, UserID: user, Role: model.ProjectRole(role)}
			return model.ProjectAccess{ProjectID: project, UserID: user, Role: grant.Role, DirectGrant: &grant}, nil
		}
		return previous(ctx, user, project)
	}
}

func allowFixtureCredential(t *testing.T, f fixture, principal model.Principal) {
	t.Helper()
	previousLock, previousRead := f.dao.LockCredentialFn, f.dao.ReadCredentialFn
	f.dao.LockCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == principal {
			return nil
		}
		return previousLock(ctx, actual, now)
	}
	f.dao.ReadCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == principal {
			return nil
		}
		return previousRead(ctx, actual, now)
	}
}

func revokeFixtureCredential(t *testing.T, f fixture, principal model.Principal) {
	t.Helper()
	previousLock, previousRead := f.dao.LockCredentialFn, f.dao.ReadCredentialFn
	f.dao.LockCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == principal {
			return model.ErrNotFound
		}
		return previousLock(ctx, actual, now)
	}
	f.dao.ReadCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == principal {
			return model.ErrNotFound
		}
		return previousRead(ctx, actual, now)
	}
}

func denyFixtureProject(t *testing.T, f fixture, principal model.Principal) {
	t.Helper()
	previous := f.dao.ProjectAccessFn
	f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user == principal.UserID {
			if project != f.project {
				t.Fatal("revoked access changed Project identity")
			}
			return model.ProjectAccess{}, model.ErrNotFound
		}
		return previous(ctx, user, project)
	}
}

func TestReadOnlyMembersAndRevokedActorsCannotDispatch(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	reader := addMember(t, f, "member")
	actor := listCredential(t, f, f.p.UserID, model.PATCredential)
	current, err := failureCurrent(f, ctx, reader, f.project, f.task, nil)
	if err != nil || current["session"].(sp.Snapshot).Operations.CanSend {
		t.Fatal("reader obtained native permission", err)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "member", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	if _, err = failureSubmit(f, ctx, reader, f.project, f.task, v.SessionID, command, nil); err == nil {
		t.Fatal("reader submitted native input")
	}
	if _, err = failureSubmit(f, ctx, actor, f.project, f.task, v.SessionID, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	if receipt, err := failureSubmit(f, ctx, f.p, f.project, f.task, v.SessionID, command, map[string]int{"SessionOperation": 1}); err != nil || receipt.OperationID != command.OperationID {
		t.Fatal("same owner could not read its original operation receipt", receipt, err)
	}
	f.data.AcceptedIDs = []string{command.OperationID}
	if _, err = fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SetSessionOperationEpoch": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	f.SelectReceiptWrite(t)
	f.SelectEpochWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = nil
	revokeFixtureCredential(t, f, actor)
	assertRejectedBegin(t, f, v, command.OperationID, map[string]int{"ProjectAccess": 1})
	if err = failureOperationAuthorization(f, ctx, v.ControllerFence, command.OperationID); err == nil {
		t.Fatal("revoked operation credential accepted")
	}
	wrong := command
	wrong.OperationID = uuid.NewString()
	wrong.SessionID = uuid.NewString()
	if _, err = failureSubmit(f, ctx, f.p, f.project, f.task, v.SessionID, wrong, nil); err == nil {
		t.Fatal("cross session command")
	}
	if _, err = failureCurrent(f, ctx, f.p, uuid.NewString(), f.task, map[string]int{"LockCredential": 0, "ProjectAccess": 0, "CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0}); err == nil {
		t.Fatal("cross project lookup")
	}
	if _, err = failureOperation(f, ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString(), nil); err == nil {
		t.Fatal("unknown operation returned")
	}
	if _, err = failureGrant(f, ctx, reader, f.project, f.task, v.SessionID, sp.Grant{}, nil); err == nil {
		t.Fatal("reader minted controller grant")
	}
	cookie := reader
	cookie.Kind = model.SessionCredential
	if _, err = failureRegister(f, ctx, cookie, f.project, f.task, f.r, map[string]int{"LockTaskRegistration": 0, "LockTask": 0, "LockCredential": 0, "ProjectAccess": 0, "FindTaskRegistration": 0}); err == nil {
		t.Fatal("cookie registered worker")
	}
	if _, err = failureGrant(f, ctx, cookie, f.project, f.task, v.SessionID, sp.Grant{}, map[string]int{"LockTask": 0, "LockCredential": 0, "ProjectAccess": 0, "SessionBotID": 0, "LockSession": 0}); err == nil {
		t.Fatal("cookie minted controller grant")
	}
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "unsupported", ControllerFence: v.ControllerFence}, nil); err == nil {
		t.Fatal("unsupported controller method")
	}
	revokeFixtureCredential(t, f, f.p)
	if _, err = fixturePoll(f, ctx, v.ControllerFence, map[string]int{"ProjectAccess": 0}); err == nil {
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
		if _, err := fixtureHandle(f, ctx, source(t, f, v, event), nil); err == nil {
			t.Fatal("invalid event persisted", event.Kind)
		}
	}
	entry["revision"] = "1"
	if _, err := fixtureHandle(f, ctx, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}), nil); err == nil {
		t.Fatal("timeline revision regressed")
	}
	entry["revision"] = "2"
	entry["content"] = []any{map[string]any{"type": "text", "text": "different"}}
	if _, err := fixtureHandle(f, ctx, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}), nil); err == nil {
		t.Fatal("same revision different body")
	}
	entry["revision"] = "3"
	batch := source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}, sp.SourceEvent{Kind: "gap", Payload: json.RawMessage(`{"reason":"Native history is unavailable"}`)})
	apply(t, f, batch)
	changed := batch
	changed.Events = changed.Events[:1]
	if _, err := fixtureHandle(f, ctx, changed, nil); err == nil {
		t.Fatal("batch identity changed")
	}
	missing := source(t, f, v, sp.SourceEvent{Kind: "gap", Payload: json.RawMessage(`{"reason":"gap"}`)})
	missing.Events[0].SourceSeq = "20"
	if _, err := fixtureHandle(f, ctx, missing, nil); err == nil {
		t.Fatal("source gap silently skipped")
	}
	n, err := failureSourceSeq(f, ctx, v.ControllerFence)
	if err != nil || n != 3 {
		t.Fatal("failed transaction advanced source watermark", n, err)
	}
	oversized := decimal(sp.MaxResourceBytes + 1)
	r := sp.Resource{ResourceID: uuid.NewString(), Status: "pending", Name: "large", ByteLength: &oversized}
	if _, err = fixtureHandle(f, ctx, source(t, f, v, sp.SourceEvent{Kind: "resource", Payload: encode(r)}), nil); err == nil {
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
	commands := make([]sp.Command, 4)
	for i := range commands {
		commands[i] = sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "reconciliation", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	}
	unseen := sp.Command{OperationID: uuid.NewString()}
	responses := configureContentOperations(t, f, append(append([]sp.Command(nil), commands...), unseen)...)
	responses.accepted = []string{commands[0].OperationID, commands[1].OperationID, commands[2].OperationID, commands[3].OperationID}
	responses.pending = 4
	f.dao.Expect("InsertSessionOperation", 4)
	deadline := f.s.now().Add(time.Minute)
	unresolved := 4
	f.dao.UnreconciledSessionOperationCountFn = func(actual context.Context, id string, epoch int64) (int, error) {
		if actual.Done() != ctx.Done() || id != v.SessionID || epoch < 1 {
			t.Fatal("journal count changed its scope")
		}
		return unresolved, nil
	}
	f.dao.UnreconciledSessionOperationsFn = func(actual context.Context, id string, epoch int64) ([]string, error) {
		if actual.Done() != ctx.Done() || id != v.SessionID || epoch != 2 {
			t.Fatal("journal list changed its scope")
		}
		return nil, nil
	}
	for _, command := range commands {
		if _, err := failureSubmit(f, ctx, f.p, f.project, f.task, v.SessionID, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}); err != nil {
			t.Fatal(err)
		}
		proposed, observed := responses.inserts[command.OperationID]
		if !observed || proposed.Actor != f.p || proposed.SessionID != v.SessionID || proposed.Receipt.State != "accepted" {
			t.Fatal("journal setup lost the proposed operation")
		}
		responses.useProposedResponse(command.OperationID, deadline)
		f.SelectSessionWrite(t)
	}
	f.dao.Expect("SetSessionOperationReceipt", 4)
	f.dao.Expect("SetSessionOperationEpoch", 4)
	f.dao.Expect("SessionOperation", 4)
	if _, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 4, "LockCredential": 5, "ProjectAccess": 5, "SetSessionOperationReceipt": 4, "SetSessionOperationEpoch": 4, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	for _, command := range commands {
		if responses.receipts[command.OperationID].State != "offered" || responses.epochs[command.OperationID] != 1 {
			t.Fatal("initial offer did not propose its receipt and epoch")
		}
		responses.useProposedResponse(command.OperationID, deadline)
	}
	f.SelectSessionWrite(t)
	responses.accepted = nil
	for _, c := range commands[:3] {
		apply(t, f, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1})
		if responses.receipts[c.OperationID].State != "dispatching" {
			t.Fatal("begin did not propose dispatching")
		}
		responses.useProposedResponse(c.OperationID, deadline)
	}
	current := reconnect(t, f, v)
	items := []sp.Reconciliation{{OperationID: commands[0].OperationID, State: "dispatching"}, {OperationID: commands[1].OperationID, State: "confirmed"}, {OperationID: commands[2].OperationID, State: "not_submitted"}}
	f.dao.Expect("SetSessionOperationReceipt", 3)
	f.dao.Expect("SetSessionOperationEpoch", 3)
	f.dao.Expect("SessionOperation", 3)
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: items, Final: false}, map[string]int{"SessionOperation": 3, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 3, "SetSessionOperationEpoch": 3})
	for i, want := range []string{"unknown", "confirmed", "unknown"} {
		id := commands[i].OperationID
		if responses.receipts[id].State != want || responses.epochs[id] != 2 {
			t.Fatal("journal result lost its proposed receipt or current epoch")
		}
		responses.useProposedResponse(id, deadline)
	}
	r, err := failureOperation(f, ctx, f.p, f.project, f.task, v.SessionID, commands[3].OperationID, nil)
	if err != nil || r.State != "offered" {
		t.Fatal("unfinished reconciliation consumed absent operation", err)
	}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: []sp.Reconciliation{{OperationID: commands[3].OperationID, State: "unknown"}}, Final: true}, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "SetSessionOperationEpoch": 1, "UnreconciledSessionOperations": 1})
	if responses.receipts[commands[3].OperationID].State != "unknown" {
		t.Fatal("final journal omitted its proposed uncertain receipt")
	}
	responses.useProposedResponse(commands[3].OperationID, deadline)
	for i, want := range []string{"unknown", "confirmed", "unknown", "unknown"} {
		got, err := failureOperation(f, ctx, f.p, f.project, f.task, v.SessionID, commands[i].OperationID, nil)
		if err != nil || got.State != want {
			t.Fatalf("reconcile %d got %s want %s: %v", i, got.State, want, err)
		}
	}
	f.dao.Expect("SetSessionOperationReceipt", 2)
	f.dao.Expect("SetSessionOperationEpoch", 2)
	f.dao.Expect("SessionOperation", 3)
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: items, Final: true}, map[string]int{"SessionOperation": 3, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 2, "SetSessionOperationEpoch": 2, "UnreconciledSessionOperations": 1})
	unresolved = 0
	state := idleState()
	apply(t, f, sp.ControllerMessage{Type: "sync_state", ControllerFence: current.ControllerFence, State: &state}, map[string]int{"UnreconciledSessionOperationCount": 1})
	publishState(t, f, current, idleState())
	offers, err := fixturePoll(f, ctx, current.ControllerFence, map[string]int{"AcceptedSessionOperations": 1})
	if err != nil || len(offers) != 0 {
		t.Fatal("uncertain operation replayed", err)
	}
	if _, err = fixtureHandle(f, ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: current.ControllerFence, Operations: []sp.Reconciliation{{OperationID: unseen.OperationID, State: "confirmed"}}, Final: true}, map[string]int{"SessionOperation": 1}); err == nil {
		t.Fatal("unknown journal operation")
	}
}
func TestDatabaseFailuresDoNotBecomeAcknowledgements(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	c := submitText(t, f, v)
	cause := errors.New("receipt storage unavailable")
	failure := &store.Error{Phase: "query", Cause: cause}
	calls := 0
	f.dao.SetSessionOperationReceiptFn = func(actual context.Context, receipt sp.Operation) error {
		calls++
		if actual.Done() != ctx.Done() || receipt.OperationID != c.OperationID || receipt.State != "offered" {
			t.Fatal("offer changed its receipt write")
		}
		return failure
	}
	if offers, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SetSessionOperationEpoch": 1}); !errors.Is(err, failure) || !errors.Is(err, cause) || calls != 1 {
		t.Fatal("failed durable offer acknowledged or lost its cause", offers, err)
	}
	if f.data.Operation.Receipt.State != "accepted" {
		t.Fatal("failed receipt changed its next DAO response")
	}
	f.dao.LockTaskFn = func(context.Context, string, string) (store.SessionTask, error) { return store.SessionTask{}, failure }
	if out, err := failureCurrent(f, ctx, f.p, f.project, f.task, map[string]int{"LockCredential": 0, "ProjectAccess": 0, "CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0}); !errors.Is(err, failure) || out != nil {
		t.Fatal("failed query succeeded or lost its cause", out, err)
	}
}
func TestExpiredGrantAndFutureEventCursorFailClosed(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	g, err := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	epoch := *f.data.Session.SourceEpoch
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "500", SchemaVersion: 1, ProjectionVersion: 1}
	if _, err = failureConnect(f, ctx, g.Token, hello, uuid.NewString(), nil); err == nil {
		t.Fatal("controller claimed uncommitted ACK")
	}
	hello.LastAckedSourceSeq = "0"
	hello.SourceEpoch = uuid.NewString()
	if _, err = failureConnect(f, ctx, g.Token, hello, uuid.NewString(), nil); err == nil {
		t.Fatal("hello silently reset source epoch")
	}
	f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	if _, err = failureConnect(f, ctx, g.Token, hello, uuid.NewString(), nil); err == nil {
		t.Fatal("expired grant")
	}
	if _, err = f.s.PutResource(ctx, g.Token, "1", uuid.NewString(), nil); err == nil {
		t.Fatal("expired resource grant")
	}
	f.s.now = time.Now
	if _, _, _, err = failureBrowserPoll(f, ctx, f.p, f.project, f.task, v.SessionID, EventCursor(v, "999"), nil); err == nil {
		t.Fatal("future event cursor")
	}
}

func TestBrowserCatchupAuthorizesEachSnapshotAndRejectsCrossTaskAccess(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	reader := addMember(t, f, "member")
	_, events, _, err := failureBrowserPoll(f, ctx, reader, f.project, f.task, v.SessionID, EventCursor(v, "0"), nil)
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
	if _, err = failureOperation(f, ctx, f.p, uuid.NewString(), f.task, v.SessionID, uuid.NewString(), map[string]int{"LockCredential": 0, "ProjectAccess": 0, "SessionBotID": 0, "LockSession": 0, "SessionOperation": 0}); err == nil {
		t.Fatal("cross-project operation access")
	}
	missing := uuid.NewString()
	oldBotID, oldLocation := f.dao.SessionBotIDFn, f.dao.SessionLocationFn
	f.dao.SessionBotIDFn = func(ctx context.Context, id string) (*string, error) {
		if id == missing {
			return nil, model.ErrNotFound
		}
		return oldBotID(ctx, id)
	}
	f.dao.SessionLocationFn = func(ctx context.Context, id string) (store.SessionLocation, error) {
		if id == missing {
			return store.SessionLocation{}, model.ErrNotFound
		}
		return oldLocation(ctx, id)
	}
	if _, err = failureOperation(f, ctx, f.p, f.project, f.task, missing, uuid.NewString(), map[string]int{"LockSession": 0, "SessionOperation": 0}); err == nil {
		t.Fatal("unknown session access")
	}
	wrong := v.ControllerFence
	wrong.SessionID = missing
	if _, err = fixturePoll(f, ctx, wrong, map[string]int{"LockTask": 0, "SessionBotID": 0, "LockSession": 0, "LockCredential": 0, "ProjectAccess": 0}); err == nil {
		t.Fatal("unknown controller session")
	}
	f.data.Task.Status = "done"
	if _, err = fixturePoll(f, ctx, v.ControllerFence, nil); err == nil {
		t.Fatal("inactive claim controller")
	}
	f.dao.LockTaskFn = func(context.Context, string, string) (store.SessionTask, error) {
		return store.SessionTask{}, model.ErrNotFound
	}
	if _, err = fixturePoll(f, ctx, v.ControllerFence, map[string]int{"SessionBotID": 0, "LockSession": 0, "LockCredential": 0, "ProjectAccess": 0}); err == nil {
		t.Fatal("deleted task controller")
	}
}

func TestGrantRenewalCannotReplaceTheParentCredentialOfAnExistingConnection(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	replacement := f.p
	replacement.CredentialID = uuid.NewString()
	allowFixtureCredential(t, f, replacement)
	if _, err := failureGrant(f, ctx, replacement, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	grant := f.writes.Grant
	if grant == nil || grant.ParentCredentialID != replacement.CredentialID || grant.SessionID != v.SessionID {
		t.Fatal("renewal changed its proposed parent credential")
	}
	f.data.Session.Parent = grant.ParentCredentialID
	f.data.Session.GrantHash = append([]byte(nil), grant.Hash...)
	f.data.Session.GrantKind, f.data.Session.GrantExpiry = grant.Kind, &grant.ExpiresAt
	f.data.GrantHash = append([]byte(nil), grant.Hash...)
	f.writes.Grant = nil
	f.SelectSessionWrite(t)
	revokeFixtureCredential(t, f, f.p)
	if _, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}, map[string]int{"ProjectAccess": 0}); err == nil {
		t.Fatal("a pending grant revived the revoked old connection")
	}
}

func failureCurrent(f fixture, ctx context.Context, p model.Principal, project, taskID string, work map[string]int) (map[string]any, error) {
	phase := f.TaskPhase(ctx, mergeFixtureCounts(map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}, work))
	defer f.dao.FinishContext(phase)
	return f.s.Current(phase, p, project, taskID)
}
func failureSubmit(f fixture, ctx context.Context, p model.Principal, project, taskID, id string, command sp.Command, work map[string]int) (sp.Operation, error) {
	phase := f.BrowserPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Submit(phase, p, project, taskID, id, command)
}
func failureOperation(f fixture, ctx context.Context, p model.Principal, project, taskID, id, operation string, work map[string]int) (sp.Operation, error) {
	phase := f.BrowserPhase(ctx, mergeFixtureCounts(map[string]int{"SessionOperation": 1}, work))
	defer f.dao.FinishContext(phase)
	return f.s.Operation(phase, p, project, taskID, id, operation)
}
func failureGrant(f fixture, ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant, work map[string]int) (GrantResult, error) {
	phase := f.BrowserPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Grant(phase, p, project, taskID, id, g)
}
func failureConnect(f fixture, ctx context.Context, token string, m sp.ControllerMessage, connection string, work map[string]int) (sp.Snapshot, error) {
	phase := f.GrantPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Connect(phase, token, m, connection)
}
func failureRegister(f fixture, ctx context.Context, p model.Principal, project, taskID string, r sp.Registration, work map[string]int) (sp.Snapshot, error) {
	phase := f.RegistrationPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Register(phase, p, project, taskID, r)
}
func failureBrowserPoll(f fixture, ctx context.Context, p model.Principal, project, taskID, id, cursor string, work map[string]int) (sp.Snapshot, []map[string]any, string, error) {
	phase := f.BrowserPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.BrowserPoll(phase, p, project, taskID, id, cursor)
}
func failureSourceSeq(f fixture, ctx context.Context, fence sp.ControllerFence) (int64, error) {
	phase := f.ControllerPhase(ctx, nil)
	defer f.dao.FinishContext(phase)
	return f.s.SourceSeq(phase, fence)
}
func failureDisconnect(f fixture, ctx context.Context, fence sp.ControllerFence) error {
	phase := f.ControllerPhase(ctx, map[string]int{"DisconnectSession": 1, "SaveSession": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Disconnect(phase, fence)
}
func failureResource(f fixture, s *Execution, ctx context.Context, p model.Principal, project, taskID, id, resource string) ([]byte, sp.Resource, error) {
	phase := f.BrowserPhase(ctx, nil)
	defer f.dao.FinishContext(phase)
	return s.Resource(phase, p, project, taskID, id, resource)
}

func failureOperationAuthorization(f fixture, ctx context.Context, fence sp.ControllerFence, id string) error {
	phase := f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 1})
	defer f.dao.FinishContext(phase)
	return f.s.controller(phase, fence, func(tx *operationTx, r *record, t task) error {
		operation, err := loadOperation(phase, tx, fence.SessionID, id)
		if err != nil {
			return err
		}
		return f.s.operationAuthorized(phase, tx, r, t, operation)
	})
}
