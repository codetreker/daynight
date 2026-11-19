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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
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

type sessionReadRevocableLease struct {
	sessionReadCloser
	lifetime context.Context
}

func (l *sessionReadRevocableLease) GateContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(parent)
	stop := context.AfterFunc(l.lifetime, func() { cancel(context.Cause(l.lifetime)) })
	if cause := context.Cause(l.lifetime); cause != nil {
		cancel(cause)
	}
	return ctx, func() { stop(); cancel(context.Canceled) }
}

type sessionReadInterruptedWriter struct {
	*httptest.ResponseRecorder
	entered, expired, stop chan struct{}
}

func (w *sessionReadInterruptedWriter) Write(p []byte) (int, error) {
	n, _ := w.ResponseRecorder.Write(p[:1])
	close(w.entered)
	select {
	case <-w.expired:
		return n, context.DeadlineExceeded
	case <-w.stop:
		return n, context.Canceled
	}
}

func (w *sessionReadInterruptedWriter) SetWriteDeadline(deadline time.Time) error {
	if deadline.IsZero() || deadline.After(time.Now()) {
		return errors.New("expected an immediate interruption deadline")
	}
	close(w.expired)
	return nil
}

func TestSessionHistoryLeaseLossInterruptsMCPDelivery(t *testing.T) {
	for _, tool := range []string{"task_session_read", "task_session_entry"} {
		for _, mode := range []string{"before write", "during write"} {
			t.Run(tool+"/"+mode, func(t *testing.T) {
				f := newSessionReadFixture(t)
				lifetime, lose := context.WithCancelCause(t.Context())
				defer lose(context.Canceled)
				lease := &sessionReadRevocableLease{lifetime: lifetime}
				mock := sessionReadMock{
					t: t,
					read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
						return ss.NewReadResult(sessionReadPage(), lease), nil
					},
					entry: func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
						chunk := sp.EntryChunk{SessionID: testUserID, HistoryEpoch: testTargetID, Source: "archive", EntryID: testTargetID, Revision: "1", SHA256: strings.Repeat("a", 64), ByteLength: "4", Offset: "0", Fragment: "🙂", EOF: true, ObservedAt: sessionReadPage().ObservedAt}
						return ss.NewReadResult(chunk, lease), nil
					},
				}
				if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
					t.Fatal(err)
				}
				req := sessionReadRequest(t, t.Context(), "http://localhost/mcp", "2025-11-25", "loss", tool, false)
				out := httptest.NewRecorder()
				if mode == "before write" {
					lose(filestorage.ErrGateLost)
					f.entry.ServeHTTP(out, req)
					if out.Code != http.StatusServiceUnavailable || !strings.Contains(out.Body.String(), `"code":"history_unavailable"`) {
						t.Fatalf("lost lease response: status=%d body=%s", out.Code, out.Body.String())
					}
				} else {
					w := &sessionReadInterruptedWriter{ResponseRecorder: out, entered: make(chan struct{}), expired: make(chan struct{}), stop: make(chan struct{})}
					defer close(w.stop)
					done := make(chan any, 1)
					go func() {
						defer func() { done <- recover() }()
						f.entry.ServeHTTP(w, req)
					}()
					waitMaterialization(t, w.entered, "Session history response write")
					if lease.closed.Load() != 0 {
						t.Fatal("archive closed before the response was interrupted")
					}
					lose(filestorage.ErrGateLost)
					select {
					case aborted := <-done:
						if aborted != http.ErrAbortHandler || out.Body.Len() != 1 {
							t.Fatalf("interrupted response: abort=%v bytes=%d", aborted, out.Body.Len())
						}
					case <-time.After(5 * time.Second):
						t.Fatal("lease loss did not unblock the response write")
					}
				}
				if lease.closed.Load() != 1 || req.Context().Err() != nil {
					t.Fatalf("response interrupted the request or did not close the lease: request=%v closeCalls=%d", req.Context().Err(), lease.closed.Load())
				}
				release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
				if err != nil {
					t.Fatalf("history response retained the Large budget after lease loss: %v", err)
				}
				release()
			})
		}
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
