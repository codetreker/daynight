package sessionrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func syncContent(t *testing.T, f fixture, v sp.Snapshot) {
	t.Helper()
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Respond: true}}
	if _, err := f.s.Handle(context.Background(), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
}
func nextContent(t *testing.T, f fixture, v sp.Snapshot) map[string]any {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		offers, err := f.s.Poll(context.Background(), v.ControllerFence)
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range offers {
			if o["type"] == "content_request" {
				return o
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("content request was not offered")
	return nil
}
func replyContent(t *testing.T, f fixture, v sp.Snapshot, request map[string]any, result *sp.ContentResult, errValue *sp.OperationError) {
	t.Helper()
	n, err := f.s.SourceSeq(context.Background(), v.ControllerFence)
	if err != nil {
		t.Fatal(err)
	}
	msg := sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: decimal(n), ContentResult: result, ContentError: errValue}
	decoded, err := sp.DecodeController(encode(msg))
	if err != nil {
		t.Fatal("wire response", err)
	}
	if _, err = f.s.Handle(context.Background(), decoded); err != nil {
		t.Fatal(err)
	}
}
func pageResult(epoch string, entries ...sp.TimelineEntry) *sp.ContentResult {
	return &sp.ContentResult{Kind: "timeline", HistoryEpoch: epoch, Items: append([]sp.TimelineEntry{}, entries...), Resources: []sp.Resource{}}
}
func localEntry(t *testing.T, seq string) sp.TimelineEntry {
	t.Helper()
	v, err := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": seq, "revision": "1", "kind": "reasoning", "text": "local-only body"}))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

type pageRead struct {
	page map[string]any
	err  error
}

func readPage(ctx context.Context, f fixture, v sp.Snapshot, direction, cursor string, limit int) <-chan pageRead {
	out := make(chan pageRead, 1)
	go func() {
		page, err := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, direction, cursor, limit)
		out <- pageRead{page, err}
	}()
	return out
}
func TestOnlineContentPageAndSourceBoundary(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	read := readPage(ctx, f, v, "tail", "", 2)
	request := nextContent(t, f, v)
	if request["limit"] != 2 || request["cursor"] != nil || request["direction"] != "tail" {
		t.Fatalf("request %#v", request)
	}
	result := pageResult(request["historyEpoch"].(string), localEntry(t, "40"), localEntry(t, "41"))
	before, after := "local-before", "local-after"
	result.BeforeCursor = &before
	result.AfterCursor = &after
	result.HasMoreBefore = true
	replyContent(t, f, v, request, result, nil)
	got := <-read
	if got.err != nil || len(got.page["items"].([]sp.TimelineEntry)) != 2 || got.page["lastEventSeq"] == nil || !got.page["hasMoreBefore"].(bool) {
		t.Fatalf("page %#v %v", got.page, got.err)
	}
	for _, table := range []string{"session_timeline", "session_events", "session_resources"} {
		var rows int
		if err := f.s.DB.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE session_id=$1", v.SessionID).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("new local session persisted content in %s: %d %v", table, rows, err)
		}
	}
	read = readPage(ctx, f, v, "before", before, 2)
	request = nextContent(t, f, v)
	if request["cursor"] != before {
		t.Fatal("native cursor changed")
	}
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string)), nil)
	if got = <-read; got.err != nil {
		t.Fatal(got.err)
	}
	if err := f.s.Disconnect(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Timeline(ctx, f.p, f.project, f.task, v.SessionID, "tail", "", 2); err == nil {
		t.Fatal("offline history returned")
	}
}
func TestContentBarrierCapturesExactEventSequenceAndIgnoresLateResponses(t *testing.T) {
	now := time.Now()
	expiry := now.Add(time.Minute)
	s := &Service{now: func() time.Time { return now }}
	v := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, HistoryEpoch: uuid.NewString(), LastEventSeq: "7", Lifecycle: "active", Synchronized: true, ConnectionState: "connected"}
	r := &record{Snapshot: v, Live: &liveSession{Synced: true}, SourceSeq: 4, LastSeen: &now, ConnectionExpiry: &expiry}
	p := &pendingContent{fence: v.ControllerFence, epoch: v.HistoryEpoch, kind: "timeline", request: map[string]any{}, reply: make(chan contentReply, 1)}
	id, err := s.content.add(p)
	if err != nil {
		t.Fatal(err)
	}
	tx := &relayTx{}
	if _, err = s.acceptContent(tx, r, sp.ControllerMessage{ControllerFence: v.ControllerFence, RequestID: id, SourceThrough: "4", ContentResult: pageResult(v.HistoryEpoch)}); err != nil {
		t.Fatal(err)
	}
	r.Snapshot.LastEventSeq = "9"
	for _, fn := range tx.committed {
		fn()
	}
	got := <-p.reply
	if got.snapshot.LastEventSeq != "7" {
		t.Fatal("captured later event sequence")
	}
	s.content.remove(id)
	if out, err := s.acceptContent(&relayTx{}, r, sp.ControllerMessage{ControllerFence: v.ControllerFence, RequestID: id, SourceThrough: "4"}); out != nil || err != nil {
		t.Fatal("late content closed connection", err)
	}
}
func TestLocalResourceChunksVerifiedWithoutServerPersistence(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	body := bytes.Repeat([]byte("a"), sp.MaxContentChunkBytes+1)
	hash := sha256.Sum256(body)
	digest, size, media := hex.EncodeToString(hash[:]), decimal(int64(len(body))), "text/plain"
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "local.txt", ByteLength: &size, SHA256: &digest, MediaType: &media}
	type response struct {
		body []byte
		err  error
	}
	done := make(chan response, 1)
	go func() {
		data, _, err := f.s.Resource(ctx, f.p, f.project, f.task, v.SessionID, descriptor.ResourceID)
		done <- response{data, err}
	}()
	for offset := 0; offset < len(body); {
		request := nextContent(t, f, v)
		if request["offset"] != decimal(int64(offset)) || request["limit"] != sp.MaxContentChunkBytes {
			t.Fatal("chunk bound", request)
		}
		end := min(offset+sp.MaxContentChunkBytes, len(body))
		replyContent(t, f, v, request, &sp.ContentResult{Kind: "resource", Resource: &descriptor, Offset: decimal(int64(offset)), Data: base64.StdEncoding.EncodeToString(body[offset:end]), EOF: end == len(body)}, nil)
		offset = end
	}
	got := <-done
	if got.err != nil || !bytes.Equal(got.body, body) {
		t.Fatal("local bytes", got.err)
	}
	if _, err := f.s.PutResource(ctx, "any", v.ConnectionEpoch, descriptor.ResourceID, body); err == nil {
		t.Fatal("former upload persisted bytes")
	}
	other := New(f.s.DB)
	if _, _, err := other.Resource(ctx, f.p, f.project, f.task, v.SessionID, descriptor.ResourceID); err == nil {
		t.Fatal("new server instance exposed local bytes without controller")
	}
	go func() {
		data, _, err := f.s.Resource(ctx, f.p, f.project, f.task, v.SessionID, descriptor.ResourceID)
		done <- response{data, err}
	}()
	request := nextContent(t, f, v)
	replyContent(t, f, v, request, &sp.ContentResult{Kind: "resource", Resource: &descriptor, Offset: "0", Data: "Yg==", EOF: true}, nil)
	if got = <-done; got.err == nil {
		t.Fatal("wrong length/hash accepted")
	}
}
func TestContentCancellationLimitsAndErrors(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	ctx, cancel := context.WithCancel(context.Background())
	done := readPage(ctx, f, v, "tail", "", 2)
	request := nextContent(t, f, v)
	cancel()
	if got := <-done; !errors.Is(got.err, context.Canceled) {
		t.Fatal(got.err)
	}
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string)), nil)
	f.s.content.mu.Lock()
	count := len(f.s.content.pending)
	f.s.content.mu.Unlock()
	if count != 0 {
		t.Fatal("canceled read leaked")
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done = readPage(ctx, f, v, "tail", "", 2)
	request = nextContent(t, f, v)
	replyContent(t, f, v, request, nil, &sp.OperationError{Code: "not_found", Message: "local history unavailable"})
	if got := <-done; got.err == nil {
		t.Fatal("local failure hidden")
	}
	var b contentBroker
	for range maxSessionContentRequests {
		if _, err := b.add(&pendingContent{fence: v.ControllerFence, request: map[string]any{}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.add(&pendingContent{fence: v.ControllerFence, request: map[string]any{}}); err == nil {
		t.Fatal("unbounded local reads")
	}
}
func TestContentMembershipIsRecheckedAfterResponse(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A second reader is independent from the controller's grant parent, so
	// revoking the reader does not revoke the native connection itself.
	viewer := core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte("reader"))
	for _, q := range []struct {
		sql  string
		args []any
	}{{`INSERT INTO users(id,uniauth_id,created_at,updated_at)VALUES($1::uuid,($1::uuid)::text,now(),now())`, []any{viewer.UserID}}, {`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at)VALUES($1,$2,$3,'reader',now(),now()+interval '1 day')`, []any{viewer.CredentialID, viewer.UserID, hash[:]}}, {`INSERT INTO project_members(project_id,user_id,role)VALUES($1,$2,'admin')`, []any{f.project, viewer.UserID}}} {
		if _, err := f.s.DB.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	reader := f
	reader.p = viewer
	done := readPage(ctx, reader, v, "tail", "", 2)
	request := nextContent(t, f, v)
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, f.project, viewer.UserID); err != nil {
		t.Fatal(err)
	}
	replyContent(t, f, v, request, pageResult(request["historyEpoch"].(string), localEntry(t, "1")), nil)
	if got := <-done; got.err == nil {
		t.Fatal("revoked reader received local content")
	}
}

func TestContentOverloadIsARequestFailureWithoutAPageBoundary(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	read := readPage(ctx, f, v, "tail", "", 2)
	request := nextContent(t, f, v)
	_, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: "999", ContentError: &sp.OperationError{Code: "rate_limited", Message: "Local content request capacity is unavailable."}})
	if err != nil {
		t.Fatal(err)
	}
	got := <-read
	var faultValue *service.Fault
	if !errors.As(got.err, &faultValue) || faultValue.Code != "rate_limited" {
		t.Fatalf("unexpected request result: %v", got.err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatalf("request overload disconnected the controller: %v", err)
	}
}
