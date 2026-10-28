package sessionrelay

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func source(t *testing.T, f fixture, v sp.Snapshot, events ...sp.SourceEvent) sp.ControllerMessage {
	t.Helper()
	var epoch string
	var n int64
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT source_epoch::text,last_source_seq FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch, &n); err != nil {
		t.Fatal(err)
	}
	for i := range events {
		events[i].SourceSeq = decimal(n + int64(i) + 1)
	}
	return sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: events}
}
func apply(t *testing.T, f fixture, m sp.ControllerMessage) map[string]any {
	t.Helper()
	out, err := f.s.Handle(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestResourceContentRequiresTheOriginalOnlineController(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	syncContent(t, f, v)
	if _, err := f.s.PutResource(ctx, "invalid", v.ConnectionEpoch, uuid.NewString(), []byte("local only")); err == nil {
		t.Fatal("server upload accepted")
	}
	if _, _, err := New(f.s.DB).Resource(ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString()); err == nil {
		t.Fatal("another server served local content")
	}
	if err := f.s.Disconnect(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.Resource(ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString()); err == nil {
		t.Fatal("offline resource served")
	}
}
func TestSourceResetAndCursorRecoveryKeepStableTimelineIdentity(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	syncContent(t, f, v)
	var entries []sp.SourceEvent
	for i := range 5 {
		entries = append(entries, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "reasoning", "text": decimal(int64(i))})})
	}
	batch := source(t, f, v, entries...)
	apply(t, f, batch)
	seq, err := f.s.SourceSeq(ctx, v.ControllerFence)
	if err != nil || seq != 5 {
		t.Fatal("source cursor", err)
	}
	snapshot, _, cursor, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	reset := sp.ControllerMessage{Type: "source_reset", ControllerFence: v.ControllerFence, PreviousSourceEpoch: batch.SourceEpoch, NewSourceEpoch: uuid.NewString(), Reason: "Native projection resumed with a new source epoch"}
	apply(t, f, reset)
	apply(t, f, reset)
	if _, err = f.s.Handle(ctx, batch); err == nil {
		t.Fatal("old source epoch accepted")
	}
	bad := reset
	bad.NewSourceEpoch = batch.SourceEpoch
	if _, err = f.s.Handle(ctx, bad); err == nil {
		t.Fatal("source epoch reused")
	}
	snapshot, events, after, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, cursor)
	if err != nil || len(events) != 1 || events[0]["kind"] != "gap" || after == cursor {
		t.Fatal("durable source gap missing", err)
	}
	if _, err := sp.DecodeSnapshot(encode(snapshot)); err != nil {
		t.Fatal("unreadable snapshot", err)
	}
	for _, event := range events {
		if _, err := sp.DecodeEvent(encode(event)); err != nil {
			t.Fatal("unreadable event", err)
		}
	}
	read := readPage(ctx, f, v, "tail", "", 2)
	request := nextContent(t, f, v)
	nativeBefore, nativeAfter := "local-before", "local-after"
	result := pageResult(request["historyEpoch"].(string), localEntry(t, "4"), localEntry(t, "5"))
	result.BeforeCursor = &nativeBefore
	result.AfterCursor = &nativeAfter
	result.HasMoreBefore = true
	replyContent(t, f, v, request, result, nil)
	page := <-read
	if page.err != nil || !page.page["hasMoreBefore"].(bool) {
		t.Fatal("tail bounds", page.err)
	}
	read = readPage(ctx, f, v, "before", nativeBefore, 2)
	request = nextContent(t, f, v)
	result = pageResult(request["historyEpoch"].(string), localEntry(t, "2"), localEntry(t, "3"))
	result.AfterCursor = &nativeAfter
	result.HasMoreAfter = true
	replyContent(t, f, v, request, result, nil)
	prior := <-read
	if prior.err != nil || !prior.page["hasMoreAfter"].(bool) {
		t.Fatal("before page", prior.err)
	}
	read = readPage(ctx, f, v, "after", nativeAfter, 2)
	request = nextContent(t, f, v)
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string), localEntry(t, "4"), localEntry(t, "5")), nil)
	next := <-read
	if next.err != nil || len(next.page["items"].([]sp.TimelineEntry)) != 2 {
		t.Fatal("after page", next.err)
	}
	read = readPage(ctx, f, v, "before", "invalid", 1)
	request = nextContent(t, f, v)
	replyContent(t, f, v, request, nil, &sp.OperationError{Code: "reset_required", Message: "Local cursor invalid"})
	if got := <-read; got.err == nil {
		t.Fatal("invalid local cursor accepted")
	}

	for _, args := range []struct {
		direction, cursor string
		limit             int
	}{{"tail", "unexpected", 1}, {"unknown", "", 1}, {"tail", "", 0}, {"tail", "", 201}} {
		if _, err = f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, args.direction, args.cursor, args.limit); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
	if err = f.s.Disconnect(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	current, err := f.s.Current(ctx, f.p, f.project, f.task)
	if err != nil || current["session"].(sp.Snapshot).ConnectionState != "disconnected" {
		t.Fatal("disconnect not durable", err)
	}
}
func TestGrantRecoveryRequiresExactStoppedGenerationAndPreservesNativeID(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	previous := "1"
	base := sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.r.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	bad := base
	bad.StopProof = nil
	if _, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, bad); err == nil {
		t.Fatal("recovery without stopped proof")
	}
	bad = base
	bad.ExecutionGeneration = "3"
	if _, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, bad); err == nil {
		t.Fatal("generation gap")
	}
	bad = base
	bad.ControllerInstanceID = f.r.ControllerInstanceID
	if _, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, bad); err == nil {
		t.Fatal("recovery reused process identity")
	}
	granted, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, base)
	if err != nil || granted.ExecutionGeneration != "2" {
		t.Fatal("recovery failed", err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("previous native execution still authorized")
	}
	// A lost grant response must not strand a successfully advanced generation.
	if repeated, retryError := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, base); retryError != nil || repeated.ExecutionGeneration != "2" {
		t.Fatal("identical recovery grant retry was not idempotent", retryError)
	} else {
		granted = repeated
	}
	changedProof := *base.StopProof
	changedProof.RecordID = uuid.NewString()
	bad = base
	bad.StopProof = &changedProof
	if _, err = f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, bad); err == nil {
		t.Fatal("different proof reused generation")
	}
	var epoch string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: v.SessionID, ClaimID: v.ClaimID, ExecutionGeneration: "2"}}, ControllerID: f.r.ControllerID, ControllerInstanceID: base.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "1", SchemaVersion: 1, ProjectionVersion: 1}
	newV, err := f.s.Connect(ctx, granted.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	changed := idleState()
	id := "another-native"
	changed.NativeSessionID = &id
	if _, err = f.s.Handle(ctx, source(t, f, newV, sp.SourceEvent{Kind: "state", Payload: encode(changed)})); err == nil {
		t.Fatal("native session replaced")
	}
	changed = idleState()
	changed.InitialInputState = "not_submitted"
	if _, err = f.s.Handle(ctx, source(t, f, newV, sp.SourceEvent{Kind: "state", Payload: encode(changed)})); err == nil {
		t.Fatal("accepted startup forgotten")
	}
	publishState(t, f, newV, idleState())
}
func TestCurrentSessionsAndCredentialRevocation(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	out, err := f.s.Current(ctx, f.p, f.project, f.task)
	if err != nil || out["status"] != "not_registered" {
		t.Fatal("missing current descriptor", err)
	}
	for _, value := range []string{`{"pullRequests":[],"worker":null}`, stringsReplaceWorkerMode(t, f, "herdr")} {
		if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE tasks SET properties=$2 WHERE id=$1`, f.task, value); err != nil {
			t.Fatal(err)
		}
		out, err = f.s.Current(ctx, f.p, f.project, f.task)
		if err != nil || out["status"] != "not_applicable" {
			t.Fatal("Herdr exposed session", err)
		}
	}
	if _, err = f.s.Register(ctx, f.p, f.project, f.task, f.r); err == nil {
		t.Fatal("registered Herdr")
	}
	invalid := f.p
	invalid.Kind = core.CredentialKind("controller")
	if _, err = f.s.Current(ctx, invalid, f.project, f.task); err == nil {
		t.Fatal("scoped identity used general API")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Current(ctx, f.p, f.project, f.task); err == nil {
		t.Fatal("revoked PAT accepted")
	}
}
func stringsReplaceWorkerMode(t *testing.T, f fixture, mode string) string {
	t.Helper()
	var raw []byte
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT properties FROM tasks WHERE id=$1`, f.task).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["worker"].(map[string]any)["agentControlMode"] = mode
	return string(encode(doc))
}
