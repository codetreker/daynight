package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func source(t *testing.T, f fixture, v sp.Snapshot, events ...sp.SourceEvent) sp.ControllerMessage {
	t.Helper()
	if f.data.Session == nil || f.data.Session.SourceEpoch == nil || f.data.Session.Snapshot.SessionID != v.SessionID {
		t.Fatal("source fixture has no matching Session response")
	}
	epoch, n := *f.data.Session.SourceEpoch, f.data.Session.SourceSeq
	for i := range events {
		events[i].SourceSeq = decimal(n + int64(i) + 1)
	}
	return sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: events}
}
func apply(t *testing.T, f fixture, m sp.ControllerMessage, work ...map[string]int) map[string]any {
	t.Helper()
	counts := map[string]int{"TouchSession": 1, "SaveSession": 1}
	for _, overrides := range work {
		counts = mergeFixtureCounts(counts, overrides)
	}
	phase := f.ControllerPhase(context.Background(), counts)
	defer f.dao.FinishContext(phase)
	out, err := f.s.Handle(phase, m)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectTouchWrite(t)
	f.SelectSessionWrite(t)
	return out
}
func TestResourceContentRequiresTheOriginalOnlineController(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	syncContent(t, f, v)
	if _, err := f.s.PutResource(ctx, "invalid", v.ConnectionEpoch, uuid.NewString(), []byte("local only")); err == nil {
		t.Fatal("server upload accepted")
	}
	if _, _, err := failureResource(f, New(f.writer), ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString()); err == nil {
		t.Fatal("another server served local content")
	}
	if err := failureDisconnect(f, ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	f.SelectDisconnectWrite(t)
	f.SelectSessionWrite(t)
	if _, _, err := failureResource(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString()); err == nil {
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
	seq, err := failureSourceSeq(f, ctx, v.ControllerFence)
	if err != nil || seq != 5 {
		t.Fatal("source cursor", err)
	}
	snapshot, _, cursor, err := failureBrowserPoll(f, ctx, f.p, f.project, f.task, v.SessionID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	reset := sp.ControllerMessage{Type: "source_reset", ControllerFence: v.ControllerFence, PreviousSourceEpoch: batch.SourceEpoch, NewSourceEpoch: uuid.NewString(), Reason: "Native projection resumed with a new source epoch"}
	apply(t, f, reset)
	apply(t, f, reset)
	if _, err = fixtureHandle(f, ctx, batch, nil); err == nil {
		t.Fatal("old source epoch accepted")
	}
	bad := reset
	bad.NewSourceEpoch = batch.SourceEpoch
	if _, err = fixtureHandle(f, ctx, bad, nil); err == nil {
		t.Fatal("source epoch reused")
	}
	snapshot, events, after, err := failureBrowserPoll(f, ctx, f.p, f.project, f.task, v.SessionID, cursor, nil)
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
	read := readPage(f.BrowserPhase(ctx, map[string]int{"LockTask": 2, "LockCredential": 2, "ProjectAccess": 2, "SessionBotID": 2, "LockSession": 2}), f, v, "tail", "", 2)
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
	read = readPage(f.BrowserPhase(ctx, map[string]int{"LockTask": 2, "LockCredential": 2, "ProjectAccess": 2, "SessionBotID": 2, "LockSession": 2}), f, v, "before", nativeBefore, 2)
	request = nextContent(t, f, v)
	result = pageResult(request["historyEpoch"].(string), localEntry(t, "2"), localEntry(t, "3"))
	result.AfterCursor = &nativeAfter
	result.HasMoreAfter = true
	replyContent(t, f, v, request, result, nil)
	prior := <-read
	if prior.err != nil || !prior.page["hasMoreAfter"].(bool) {
		t.Fatal("before page", prior.err)
	}
	read = readPage(f.BrowserPhase(ctx, map[string]int{"LockTask": 2, "LockCredential": 2, "ProjectAccess": 2, "SessionBotID": 2, "LockSession": 2}), f, v, "after", nativeAfter, 2)
	request = nextContent(t, f, v)
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string), localEntry(t, "4"), localEntry(t, "5")), nil)
	next := <-read
	if next.err != nil || len(next.page["items"].([]sp.TimelineEntry)) != 2 {
		t.Fatal("after page", next.err)
	}
	readCtx, cancelRead := context.WithTimeout(ctx, 5*time.Second)
	defer cancelRead()
	read = readPage(f.BrowserPhase(readCtx, map[string]int{"LockTask": 2, "LockCredential": 2, "ProjectAccess": 2, "SessionBotID": 2, "LockSession": 2}), f, v, "before", "controller-owned-invalid-cursor", 1)
	request = nextContent(t, f, v)
	if request["kind"] != "timeline" || request["direction"] != "before" || request["cursor"] != "controller-owned-invalid-cursor" || request["limit"] != 1 {
		t.Fatalf("local cursor request changed: %#v", request)
	}
	replyContent(t, f, v, request, nil, &sp.OperationError{Code: "reset_required", Message: "Local cursor invalid"})
	got := <-read
	var rejected *model.Fault
	if !errors.As(got.err, &rejected) || rejected.Code != "reset_required" || got.page != nil {
		t.Fatalf("local cursor reset response: page=%#v error=%v", got.page, got.err)
	}
	f.s.content.mu.Lock()
	pending := len(f.s.content.pending)
	f.s.content.mu.Unlock()
	if pending != 0 {
		t.Fatal("completed cursor reset retained a content request")
	}

	for _, args := range []struct {
		direction, cursor string
		limit             int
	}{{"tail", "unexpected", 1}, {"unknown", "", 1}, {"tail", "", 0}, {"tail", "", 201}} {
		if _, err = f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, args.direction, args.cursor, args.limit); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
	if err = failureDisconnect(f, ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	f.SelectDisconnectWrite(t)
	f.SelectSessionWrite(t)
	current, err := failureCurrent(f, ctx, f.p, f.project, f.task, nil)
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
	if _, err := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, bad, nil); err == nil {
		t.Fatal("recovery without stopped proof")
	}
	bad = base
	bad.ExecutionGeneration = "3"
	if _, err := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, bad, nil); err == nil {
		t.Fatal("generation gap")
	}
	bad = base
	bad.ControllerInstanceID = f.r.ControllerInstanceID
	if _, err := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, bad, nil); err == nil {
		t.Fatal("recovery reused process identity")
	}
	granted, err := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, base, map[string]int{"SetSessionGenerationStop": 1, "SetSessionGrant": 1, "SaveSession": 1})
	if err != nil || granted.ExecutionGeneration != "2" {
		t.Fatal("recovery failed", err)
	}
	if !jsonEqual(f.writes.StopProof, encode(base.StopProof)) {
		t.Fatal("generation stop write changed the exact proof")
	}
	f.data.Session.StopProof = append([]byte(nil), f.writes.StopProof...)
	f.writes.StopProof = nil
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	if _, err = fixturePoll(f, ctx, v.ControllerFence, nil); err == nil {
		t.Fatal("previous native execution still authorized")
	}
	// A lost grant response must not strand a successfully advanced generation.
	if repeated, retryError := failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, base, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}); retryError != nil || repeated.ExecutionGeneration != "2" {
		t.Fatal("identical recovery grant retry was not idempotent", retryError)
	} else {
		granted = repeated
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	changedProof := *base.StopProof
	changedProof.RecordID = uuid.NewString()
	bad = base
	bad.StopProof = &changedProof
	if _, err = failureGrant(f, ctx, f.p, f.project, f.task, v.SessionID, bad, nil); err == nil {
		t.Fatal("different proof reused generation")
	}
	epoch := *f.data.Session.SourceEpoch
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: v.SessionID, ClaimID: v.ClaimID, ExecutionGeneration: "2"}}, ControllerID: f.r.ControllerID, ControllerInstanceID: base.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "1", SchemaVersion: 1, ProjectionVersion: 1}
	newV, err := failureConnect(f, ctx, granted.Token, hello, uuid.NewString(), map[string]int{"ConnectSession": 1, "SaveSession": 1})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectConnectionWrite(t)
	changed := idleState()
	id := "another-native"
	changed.NativeSessionID = &id
	if _, err = fixtureHandle(f, ctx, source(t, f, newV, sp.SourceEvent{Kind: "state", Payload: encode(changed)}), nil); err == nil {
		t.Fatal("native session replaced")
	}
	changed = idleState()
	changed.InitialInputState = "not_submitted"
	if _, err = fixtureHandle(f, ctx, source(t, f, newV, sp.SourceEvent{Kind: "state", Payload: encode(changed)}), nil); err == nil {
		t.Fatal("accepted startup forgotten")
	}
	publishState(t, f, newV, idleState())
}
func TestCurrentSessionsAndCredentialRevocation(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	out, err := failureCurrent(f, ctx, f.p, f.project, f.task, map[string]int{"SessionBotID": 0, "LockSession": 0})
	if err != nil || out["status"] != "not_registered" {
		t.Fatal("missing current descriptor", err)
	}
	worker := *f.data.Task.Worker
	for _, mode := range []model.WorkerAgentControlMode{"", model.AgentControlModeHerdr} {
		if mode == "" {
			f.data.Task.Worker = nil
		} else {
			worker.AgentControlMode = mode
			f.data.Task.Worker = &worker
		}
		out, err = failureCurrent(f, ctx, f.p, f.project, f.task, map[string]int{"CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0})
		if err != nil || out["status"] != "not_applicable" {
			t.Fatal("Herdr exposed session", err)
		}
	}
	if _, err = failureRegister(f, ctx, f.p, f.project, f.task, f.r, map[string]int{"FindTaskRegistration": 0}); err == nil {
		t.Fatal("registered Herdr")
	}
	invalid := f.p
	invalid.Kind = model.CredentialKind("controller")
	if _, err = failureCurrent(f, ctx, invalid, f.project, f.task, map[string]int{"LockCredential": 0, "ProjectAccess": 0, "CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0}); err == nil {
		t.Fatal("scoped identity used general API")
	}
	revokeFixtureCredential(t, f, f.p)
	if _, err = failureCurrent(f, ctx, f.p, f.project, f.task, map[string]int{"ProjectAccess": 0, "CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0}); err == nil {
		t.Fatal("revoked PAT accepted")
	}
}
