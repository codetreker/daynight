package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func sessionReadRequest(t *testing.T, ctx context.Context, endpoint, version, id, name string, batch bool) *http.Request {
	t.Helper()
	args := sessionReadArgs()
	if name == "task_session_entry" {
		args["cursor"] = "body"
	}
	call := rpcTaskCall(id, version, name, args)
	var input any = call
	if batch {
		input = []any{call}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("X-Request-ID", "rpc-session")
	if !batch {
		req.Header.Set("MCP-Protocol-Version", version)
	}
	if version == "2026-07-28" {
		req.Header.Set("MCP-Method", "tools/call")
		req.Header.Set("MCP-Name", name)
	}
	return req
}

func TestSessionReadDedicatedBudgetCoversFullHTTPEncoding(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for _, batch := range []bool{false, true} {
			if batch && version == "2026-07-28" {
				continue
			}
			t.Run(version+map[bool]string{false: "/single", true: "/batch"}[batch], func(t *testing.T) {
				f := newSessionReadFixture(t)
				calls := 0
				overhead := 0
				mock := sessionReadMock{t: t, read: func(_ context.Context, _ model.Principal, _, _, _ string, in ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
					calls++
					overhead = in.ResponseOverhead
					page := sessionReadPage()
					body := map[string]any{"entryId": testTargetID, "entrySeq": "1", "revision": "1", "kind": "reasoning", "text": "🙂\u2028\u2029"}
					raw, _ := json.Marshal(body)
					page.Items = []sp.MessageItem{{EntryID: testTargetID, EntrySeq: "1", Revision: "1", Kind: "reasoning", Body: raw, Resources: []sp.InspectionResource{}}}
					base, _ := json.Marshal(page)
					fill := sp.MaxHistoryResponseBytes - in.ResponseOverhead - len(base)
					if fill < 0 {
						t.Errorf("unexpected envelope size %d", overhead)
						return nil, errors.New("budget exhausted")
					}
					body["text"] = body["text"].(string) + strings.Repeat("<", fill/6) + strings.Repeat("x", fill%6)
					page.Items[0].Body, _ = json.Marshal(body)
					return ss.NewReadResult(page, nil), nil
				}}
				if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
					t.Fatal(err)
				}
				id := strings.Repeat("x", 30000)
				req := sessionReadRequest(t, t.Context(), f.server.URL, version, id, "task_session_read", batch)
				resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				raw, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if resp.StatusCode != 200 || calls != 1 || overhead < 30000 || len(raw) > sp.MaxHistoryResponseBytes || len(raw) < sp.MaxHistoryResponseBytes-40 {
					t.Fatalf("status=%d calls=%d overhead=%d bytes=%d", resp.StatusCode, calls, overhead, len(raw))
				}
				var replies []map[string]any
				if batch {
					err = json.Unmarshal(raw, &replies)
				} else {
					var reply map[string]any
					err = json.Unmarshal(raw, &reply)
					replies = []map[string]any{reply}
				}
				if err != nil || len(replies) != 1 || replies[0]["id"] != id || object(t, replies[0]["result"])["isError"] == true {
					t.Fatalf("wire lost data: %v", err)
				}
			})
		}
	}
}

type sessionReadCloser struct {
	closed atomic.Int32
	done   chan struct{}
}

func (c *sessionReadCloser) Close() error {
	if c.closed.Add(1) == 1 && c.done != nil {
		close(c.done)
	}
	return nil
}

type sessionReadBlockedWriter struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
	once             sync.Once
}

func (w *sessionReadBlockedWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.release })
	return w.ResponseRecorder.Write(p)
}

func TestSessionReadRetainsLeaseAndLargeBudgetThroughResponseDelivery(t *testing.T) {
	for _, cancelDelivery := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "cancel"}[cancelDelivery], func(t *testing.T) {
			f := newSessionReadFixture(t)
			lease := &sessionReadCloser{}
			mock := sessionReadMock{t: t, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
				return ss.NewReadResult(sessionReadPage(), lease), nil
			}}
			if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			w := &sessionReadBlockedWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
			var once sync.Once
			unblock := func() { once.Do(func() { close(w.release) }) }
			t.Cleanup(unblock)
			req := sessionReadRequest(t, ctx, "http://localhost/mcp", "2025-11-25", "delivery", "task_session_read", false)
			done := make(chan struct{})
			go func() { f.entry.ServeHTTP(w, req); close(done) }()
			waitMaterialization(t, w.entered, "history response write")
			if cancelDelivery {
				cancel()
			}
			if lease.closed.Load() != 0 {
				t.Fatal("archive closed before response delivery")
			}
			release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
			if err == nil {
				release()
				t.Fatal("Large permit released before response delivery")
			}
			if !errors.Is(err, ErrResourceBusy) {
				t.Fatal(err)
			}
			unblock()
			waitMaterialization(t, done, "history response finish")
			if lease.closed.Load() != 1 {
				t.Fatalf("lease closed %d times", lease.closed.Load())
			}
			release, err = f.entry.budget.Acquire(t.Context(), BudgetLarge)
			if err != nil {
				t.Fatal(err)
			}
			release()
		})
	}
}

func TestSessionReadCanceledCallbackRetainsLargeBudgetAndClosesReturnedLease(t *testing.T) {
	f := newSessionReadFixture(t)
	entered, canceled, unblock, returned := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	lease := &sessionReadCloser{done: make(chan struct{})}
	var once sync.Once
	releaseCallback := func() { once.Do(func() { close(unblock) }) }
	t.Cleanup(releaseCallback)
	mock := sessionReadMock{t: t, entry: func(ctx context.Context, _ model.Principal, _, _, _ string, _ ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
		defer close(returned)
		close(entered)
		<-ctx.Done()
		close(canceled)
		<-unblock
		return ss.NewReadResult(sp.EntryChunk{}, lease), ctx.Err()
	}}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := sessionReadRequest(t, ctx, f.server.URL, "2025-11-25", "canceled", "task_session_entry", false)
	clientDone := make(chan struct{})
	go func() {
		resp, _ := http.DefaultClient.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
		close(clientDone)
	}()
	waitMaterialization(t, entered, "entry callback")
	cancel()
	waitMaterialization(t, canceled, "entry cancellation")
	release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err == nil {
		release()
		t.Fatal("canceled callback released Large permit")
	}
	if !errors.Is(err, ErrResourceBusy) {
		t.Fatal(err)
	}
	if lease.closed.Load() != 0 {
		t.Fatal("lease closed before callback returned")
	}
	releaseCallback()
	waitMaterialization(t, returned, "entry callback exit")
	waitMaterialization(t, lease.done, "canceled entry cleanup")
	waitMaterialization(t, clientDone, "canceled client finish")
	if lease.closed.Load() != 1 {
		t.Fatalf("lease closed %d times", lease.closed.Load())
	}
	release, err = f.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestSessionReadEntryBudgetIncludesLargeRPCIdentity(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for _, batch := range []bool{false, true} {
			if batch && version == "2026-07-28" {
				continue
			}
			t.Run(version+map[bool]string{false: "/single", true: "/batch"}[batch], func(t *testing.T) {
				f := newSessionReadFixture(t)
				mock := sessionReadMock{t: t, entry: func(_ context.Context, _ model.Principal, _, _, id string, in ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
					chunk := sp.EntryChunk{SessionID: id, HistoryEpoch: testTargetID, Source: "archive", EntryID: testTargetID, Revision: "1", SHA256: strings.Repeat("a", 64), ByteLength: "40000", Offset: "0", Fragment: "🙂\u2028\u2029", ObservedAt: sessionReadPage().ObservedAt}
					raw, _ := json.Marshal(chunk)
					fill := sp.MaxHistoryResponseBytes - in.ResponseOverhead - len(raw)
					if fill < 0 || fill+len(chunk.Fragment) > sp.MaxEntryChunkBytes {
						t.Errorf("entry budget was not transferred: %+v", in)
						return nil, errors.New("incorrect chunk budget")
					}
					chunk.Fragment += strings.Repeat("x", fill)
					return ss.NewReadResult(chunk, nil), nil
				}}
				if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
					t.Fatal(err)
				}
				req := sessionReadRequest(t, t.Context(), f.server.URL, version, strings.Repeat("x", 230000), "task_session_entry", batch)
				resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				raw, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if resp.StatusCode != 200 || len(raw) > sp.MaxHistoryResponseBytes || len(raw) < sp.MaxHistoryResponseBytes-40 || bytes.Contains(raw, []byte(`"isError":true`)) {
					t.Fatalf("entry status=%d bytes=%d", resp.StatusCode, len(raw))
				}
			})
		}
	}
}
