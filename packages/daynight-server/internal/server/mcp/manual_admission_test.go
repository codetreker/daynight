package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type manualBarrierWriter struct {
	*httptest.ResponseRecorder
	entered, allow chan struct{}
	once           sync.Once
	fail           bool
}

func (w *manualBarrierWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.allow
	if w.fail {
		return 0, errors.New("test write failure")
	}
	return w.ResponseRecorder.Write(p)
}
func (w *manualBarrierWriter) Unwrap() http.ResponseWriter { return w.ResponseRecorder }

func TestManualBatchAdmissionAndDelivery(t *testing.T) {
	for _, mode := range []string{"normal", "cancel", "write failure"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			e, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := e.Shutdown(ctx); err != nil {
					t.Error(err)
				}
			})
			doc := manualDocument{Resource: sdk.Resource{Name: "test", URI: "daynight://manuals/test.md", MIMEType: "text/markdown"}, Text: "complete body"}
			e.server.AddResource(&doc.Resource, e.manualHandler(doc))
			var held []func()
			for range 14 {
				release, err := e.budget.Acquire(t.Context(), BudgetControl)
				if err != nil {
					t.Fatal(err)
				}
				held = append(held, release)
			}
			t.Cleanup(func() {
				for _, release := range held {
					release()
				}
			})
			var calls []string
			for i := range 4 {
				calls = append(calls, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"resources/read","params":{"uri":%q}}`, i, doc.Resource.URI))
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest(http.MethodPost, "http://localhost/mcp", strings.NewReader("["+strings.Join(calls, ",")+"]")).WithContext(ctx)
			req.Header.Set("Authorization", "Bearer alice")
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("X-Request-ID", "manual-batch")
			w := &manualBarrierWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), allow: make(chan struct{}), fail: mode == "write failure"}
			var unblock sync.Once
			t.Cleanup(func() { unblock.Do(func() { close(w.allow) }) })
			done := make(chan struct{})
			go func() { defer close(done); httpx.RequestLogging(logger, e).ServeHTTP(w, req) }()
			waitMaterialization(t, w.entered, "manual response delivery")
			if release, err := e.budget.Acquire(t.Context(), BudgetControl); !errors.Is(err, ErrResourceBusy) {
				if err == nil {
					release()
				}
				t.Fatalf("permits released before delivery: %v", err)
			}
			if mode == "cancel" {
				cancel()
				if release, err := e.budget.Acquire(t.Context(), BudgetControl); !errors.Is(err, ErrResourceBusy) {
					if err == nil {
						release()
					}
					t.Fatalf("permits released after cancellation but before delivery: %v", err)
				}
			}
			unblock.Do(func() { close(w.allow) })
			waitMaterialization(t, done, "manual response completion")
			var after []func()
			for range 2 {
				release, err := e.budget.Acquire(t.Context(), BudgetControl)
				if err != nil {
					t.Fatalf("permit not released after %s: %v", mode, err)
				}
				after = append(after, release)
			}
			for _, release := range after {
				release()
			}
			if mode == "write failure" {
				if !strings.Contains(logs.String(), `"phase":"delivery"`) || !strings.Contains(logs.String(), `"request_id":"manual-batch"`) {
					t.Fatalf("missing delivery failure log: %s", logs.String())
				}
				return
			}
			if strings.Contains(logs.String(), `"phase":"delivery"`) {
				t.Fatalf("successful writer reported delivery failure: %s", logs.String())
			}
			var responses []struct {
				ID     int `json:"id"`
				Result *struct {
					Contents []struct{ URI, Text string } `json:"contents"`
				} `json:"result"`
				Error *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &responses); err != nil {
				t.Fatalf("batch JSON: %v: %s", err, w.Body.String())
			}
			if len(responses) != 4 {
				t.Fatalf("responses: %s", w.Body.String())
			}
			seen := map[int]bool{}
			success, busy := 0, 0
			for _, response := range responses {
				if response.ID < 0 || response.ID >= 4 || seen[response.ID] {
					t.Fatalf("wrong response ID: %+v", response)
				}
				seen[response.ID] = true
				switch {
				case response.Result != nil && response.Error == nil:
					if len(response.Result.Contents) != 1 || response.Result.Contents[0].Text != doc.Text || response.Result.Contents[0].URI != doc.Resource.URI {
						t.Fatalf("partial body: %+v", response)
					}
					success++
				case response.Result == nil && response.Error != nil && response.Error.Code == -32603 && response.Error.Message == "Internal error":
					busy++
				default:
					t.Fatalf("unexpected result: %+v", response)
				}
			}
			if success != 2 || busy != 2 {
				t.Fatalf("success=%d busy=%d", success, busy)
			}
			if !strings.Contains(logs.String(), `"phase":"manual_admission"`) || !strings.Contains(logs.String(), `"cause":"resource_busy"`) || !strings.Contains(logs.String(), `"request_id":"manual-batch"`) {
				t.Fatalf("missing admission log: %s", logs.String())
			}
		})
	}
}

func TestManualInvocationScopeAndCancellation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := manualDocument{Resource: sdk.Resource{Name: "test", URI: "daynight://manuals/test.md", MIMEType: "text/markdown"}, Text: "body"}
	handler := e.manualHandler(doc)
	if result, err := handler(t.Context(), nil); result != nil || err == nil {
		t.Fatalf("missing scope: %v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	scope := &requestScope{actor: RequestActor{Context: ctx, Budget: e.budget}}
	result, err := handler(context.WithValue(context.Background(), scopeKey{}, scope), nil)
	if result != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v %v", result, err)
	}
	scope.delivered()
	e.BeginShutdown()
	scope = &requestScope{actor: RequestActor{Context: context.Background(), Budget: e.budget}}
	result, err = handler(context.WithValue(context.Background(), scopeKey{}, scope), nil)
	if result != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown: %v %v", result, err)
	}
}

func TestInvocationRetainsPermitAfterHTTPUntilCallbackEnds(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	scope := &requestScope{actor: RequestActor{Context: context.Background(), Budget: e.budget}}
	call, err := e.beginInvocation(context.WithValue(context.Background(), scopeKey{}, scope))
	if err != nil {
		t.Fatal(err)
	}
	release, err := e.budget.Acquire(call.ctx, BudgetControl)
	if err != nil {
		t.Fatal(err)
	}
	scope.hold(release)
	scope.delivered()
	if len(e.budget.control) != 1 {
		t.Fatal("permit released while callback was active")
	}
	call.done()
	call.done()
	if len(e.budget.control) != 0 {
		t.Fatal("permit retained after both completions")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		t.Fatalf("callback did not drain: %v", err)
	}
}
