package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
func TestResourcesAreBoundedVerifiedAndPortableBetweenInstances(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	resourceID := uuid.NewString()
	content := []byte("verified content")
	hash := sha256.Sum256(content)
	digest := hex.EncodeToString(hash[:])
	size := decimal(int64(len(content)))
	descriptor := sp.Resource{ResourceID: resourceID, Status: "pending", Name: "result.txt", MediaType: nil, ByteLength: &size, SHA256: &digest}
	entry := map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "tool_call", "callId": "call", "name": "read", "input": "{}", "output": []any{map[string]any{"type": "resource", "resourceId": resourceID, "label": "result"}}, "status": "completed", "truncated": false}
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}, sp.SourceEvent{Kind: "resource", Payload: encode(descriptor)}))
	g, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	missingID := uuid.NewString()
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "resource", "resourceId": missingID, "label": "missing"}}})}))
	if _, err = f.s.PutResource(ctx, g.Token, v.ConnectionEpoch, missingID, content); err == nil {
		t.Fatal("uploaded resource without descriptor")
	}
	if _, err = f.s.PutResource(ctx, g.Token, v.ConnectionEpoch, resourceID, []byte("wrong")); err == nil {
		t.Fatal("wrong digest accepted")
	}
	if _, err = f.s.PutResource(ctx, g.Token, v.ConnectionEpoch, uuid.NewString(), content); err == nil {
		t.Fatal("unreferenced upload accepted")
	}
	if _, _, err = f.s.Resource(ctx, f.p, f.project, f.task, v.SessionID, resourceID); err == nil {
		t.Fatal("pending bytes read")
	}
	for range 2 {
		got, err := f.s.PutResource(ctx, g.Token, v.ConnectionEpoch, resourceID, content)
		if err != nil || got.Status != "available" {
			t.Fatalf("upload %#v %v", got, err)
		}
	}
	other := New(f.s.DB)
	body, got, err := other.Resource(ctx, f.p, f.project, f.task, v.SessionID, resourceID)
	if err != nil || string(body) != string(content) || *got.SHA256 != digest {
		t.Fatal("cross-instance content changed", err)
	}
	page, err := other.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "tail", "", 10)
	if err != nil || len(page["resources"].([]sp.Resource)) != 1 {
		t.Fatal("resource metadata absent from history", err)
	}
	if _, err = f.s.PutResource(ctx, "invalid", v.ConnectionEpoch, resourceID, content); err == nil {
		t.Fatal("invalid grant upload")
	}
	if _, err = f.s.PutResource(ctx, g.Token, "999", resourceID, content); err == nil {
		t.Fatal("stale connection upload")
	}
	if _, err = f.s.PutResource(ctx, g.Token, v.ConnectionEpoch, resourceID, make([]byte, sp.MaxResourceBytes+1)); err == nil {
		t.Fatal("oversize upload")
	}
	descriptor.Status = "available"
	if _, err = f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "resource", Payload: encode(descriptor)})); err == nil {
		t.Fatal("controller forged resource availability")
	}
	descriptor.Status = "pending"
	if _, err = f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "resource", Payload: encode(descriptor)})); err == nil {
		t.Fatal("available resource downgraded")
	}
}
func TestSourceResetAndCursorRecoveryKeepStableTimelineIdentity(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
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
	page, err := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "tail", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !page["hasMoreBefore"].(bool) || page["hasMoreAfter"].(bool) {
		t.Fatal("incorrect tail bounds")
	}
	prior, err := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "before", page["beforeCursor"].(string), 2)
	if err != nil || !prior["hasMoreAfter"].(bool) {
		t.Fatal("before page missing", err)
	}
	next, err := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "after", prior["afterCursor"].(string), 2)
	if err != nil || len(next["items"].([]sp.TimelineEntry)) != 2 {
		t.Fatal("after page missing", err)
	}
	for _, args := range []struct {
		direction, cursor string
		limit             int
	}{{"tail", "unexpected", 1}, {"before", "invalid", 1}, {"unknown", "", 1}, {"tail", "", 0}, {"tail", "", 201}} {
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
