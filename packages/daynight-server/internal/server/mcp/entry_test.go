package mcp

import (
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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type testAuthenticator struct{}

func (testAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	if kind == model.PATCredential && (token == "alice" || token == "bob") {
		return model.Principal{Kind: kind, UserID: token, CredentialID: "credential-" + token}, nil
	}
	return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "invalid credential"}
}

type headerTransport struct {
	base  http.RoundTripper
	token string
}

func (h headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+h.token)
	r.Header.Set("X-Request-ID", "test-request")
	return h.base.RoundTrip(r)
}

type entryFixture struct {
	entry    *Entry
	server   *httptest.Server
	entered  chan struct{}
	canceled chan struct{}
}

func newEntryFixture(t *testing.T) *entryFixture {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", []string{"https://client.test"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	f := &entryFixture{entry: e, entered: make(chan struct{}, 10), canceled: make(chan struct{}, 10)}
	input := map[string]any{"type": "object", "properties": map[string]any{"mode": map[string]any{"type": "string"}}, "required": []string{"mode"}, "additionalProperties": false}
	output := map[string]any{"type": "object", "properties": map[string]any{
		"data":  map[string]any{"type": "object", "properties": map[string]any{"user": map[string]any{"type": "string"}, "credential": map[string]any{"type": "string"}}, "required": []string{"user", "credential"}},
		"meta":  map[string]any{"type": "object", "properties": map[string]any{"requestId": map[string]any{"type": "string"}, "outcome": map[string]any{"type": "string"}}, "required": []string{"requestId"}},
		"error": map[string]any{"type": "object", "properties": map[string]any{"code": map[string]any{"type": "string"}, "message": map[string]any{"type": "string"}, "requestId": map[string]any{"type": "string"}, "writeOutcome": map[string]any{"type": "string"}, "phase": map[string]any{"type": "string"}, "refs": map[string]any{"type": "object"}}, "required": []string{"code", "message", "requestId"}},
	}, "oneOf": []any{map[string]any{"required": []string{"data", "meta"}, "not": map[string]any{"required": []string{"error"}}}, map[string]any{"required": []string{"error"}, "not": map[string]any{"required": []string{"data"}}}}}
	err = e.RegisterTool(&sdk.Tool{Name: "test_only", Description: "Test tool", InputSchema: input, OutputSchema: output}, BudgetControl, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
		var args struct {
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return ToolResult{}, err
		}
		switch args.Mode {
		case "deny":
			return ToolResult{}, &model.Fault{Code: "forbidden", Message: "denied"}
		case "unknown":
			return ToolResult{Refs: map[string]any{"id": "original"}}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("private detail")}
		case "bad_output":
			return ToolResult{Data: map[string]any{"user": 7}, WriteOutcome: "confirmed", Refs: map[string]any{"id": "original"}}, nil
		case "wait":
			f.entered <- struct{}{}
			<-ctx.Done()
			f.canceled <- struct{}{}
			return ToolResult{}, ctx.Err()
		default:
			return ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "credential": actor.AuthorityRef.ID}}, nil
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(httpx.RequestLogging(logger, e))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		f.server.Close()
	})
	return f
}

func (f *entryFixture) client(t *testing.T, version, token string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "test-client", Version: "1"}, nil)
	tr := &sdk.StreamableClientTransport{Endpoint: f.server.URL, HTTPClient: &http.Client{Transport: headerTransport{base: http.DefaultTransport, token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, tr, &sdk.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatalf("connect %s: %v", version, err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callTest(t *testing.T, c *sdk.ClientSession, args any) (*sdk.CallToolResult, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.CallTool(ctx, &sdk.CallToolParams{Name: "test_only", Arguments: args})
}
func structured(t *testing.T, r *sdk.CallToolResult) map[string]any {
	t.Helper()
	b, err := json.Marshal(r.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func object(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("expected object, got %#v", v)
	}
	return m
}

func TestMCPHTTPClientsAndFailureLayers(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			f := newEntryFixture(t)
			c := f.client(t, version, "alice")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			list, err := c.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(list.Tools) != 1 || list.Tools[0].Name != "test_only" {
				t.Fatalf("tools: %#v", list.Tools)
			}
			if list.CacheScope != "private" || list.TTLMs != 0 {
				t.Errorf("unexpected protocol cache policy: %#v", list.Cacheable)
			}
			result, err := callTest(t, c, map[string]any{"mode": "ok"})
			if err != nil {
				t.Fatal(err)
			}
			out := structured(t, result)
			data := object(t, out["data"])
			meta := object(t, out["meta"])
			if result.IsError || data["user"] != "alice" || data["credential"] != "credential-alice" || meta["requestId"] != "test-request" {
				t.Fatalf("success: %#v", out)
			}
			var rpcErr *jsonrpc.Error
			if _, err = callTest(t, c, []any{"bad"}); !errors.As(err, &rpcErr) || rpcErr.Code != jsonrpc.CodeInvalidParams {
				t.Errorf("non-object arguments should be JSON-RPC invalid params, got %v", err)
			}
			cases := []struct {
				name                 string
				args                 any
				code, outcome, phase string
			}{
				{"field", map[string]any{"mode": 42}, "invalid_input", "", ""},
				{"denial", map[string]any{"mode": "deny"}, "forbidden", "", ""},
				{"unknown", map[string]any{"mode": "unknown"}, "internal_error", "unknown", "commit"},
				{"output", map[string]any{"mode": "bad_output"}, "internal_error", "confirmed", "output"},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					r, err := callTest(t, c, tc.args)
					if err != nil {
						t.Fatal(err)
					}
					if !r.IsError {
						t.Fatal("expected tool error")
					}
					e := object(t, structured(t, r)["error"])
					if e["code"] != tc.code || e["requestId"] != "test-request" || (tc.outcome != "" && e["writeOutcome"] != tc.outcome) || (tc.phase != "" && e["phase"] != tc.phase) {
						t.Fatalf("error envelope: %#v", e)
					}
					if tc.outcome != "" && object(t, e["refs"])["id"] != "original" {
						t.Fatalf("missing refs: %#v", e)
					}
				})
			}
		})
	}
}

func TestMCPHTTPConcurrentIdentities(t *testing.T) {
	f := newEntryFixture(t)
	clients := []*sdk.ClientSession{f.client(t, "2026-07-28", "alice"), f.client(t, "2026-07-28", "bob")}
	var wg sync.WaitGroup
	failures := make(chan string, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			r, err := clients[i%2].CallTool(ctx, &sdk.CallToolParams{Name: "test_only", Arguments: map[string]any{"mode": "ok"}})
			if err != nil {
				failures <- err.Error()
				return
			}
			b, err := json.Marshal(r.StructuredContent)
			if err != nil {
				failures <- err.Error()
				return
			}
			var v struct {
				Data struct{ User, Credential string } `json:"data"`
			}
			if err = json.Unmarshal(b, &v); err != nil {
				failures <- err.Error()
				return
			}
			want := []string{"alice", "bob"}[i%2]
			if r.IsError || v.Data.User != want || v.Data.Credential != "credential-"+want {
				failures <- fmt.Sprintf("want %s, received %s", want, b)
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for f := range failures {
		t.Error(f)
	}
}

func TestMCPHTTPAuthenticationOriginAndCache(t *testing.T) {
	f := newEntryFixture(t)
	cases := []struct {
		name, auth, origin string
		want               int
	}{{"missing", "", "", 401}, {"bad", "Bearer invalid", "", 401}, {"cookie", "", "", 401}, {"invalid origin", "Bearer alice", "https://evil.test", 403}, {"allowed origin", "Bearer alice", "https://client.test", 200}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest("POST", f.server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("MCP-Protocol-Version", "2025-11-25")
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			req.Header.Set("Cookie", "session=not-a-bearer")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d: %s", resp.StatusCode, b)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("cache header %q", resp.Header.Get("Cache-Control"))
			}
			if tc.name == "allowed origin" && resp.Header.Get("Access-Control-Allow-Origin") != tc.origin {
				t.Errorf("CORS header %q", resp.Header.Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func TestMCPHTTPRejectsDuplicateAuthorization(t *testing.T) {
	f := newEntryFixture(t)
	req, err := http.NewRequest(http.MethodPost, f.server.URL, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Add("Authorization", "Bearer alice")
	req.Header.Add("Authorization", "Bearer bob")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("duplicate authorization status %d", resp.StatusCode)
	}
}

func TestMCPHTTPUnregisteredEntryHasNoTools(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(httpx.RequestLogging(logger, e))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		s.Close()
	})
	f := &entryFixture{entry: e, server: s}
	c := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := c.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) != 0 {
		t.Fatalf("unregistered entry exposed tools: %#v", list.Tools)
	}
}

func TestMCPHTTPCancellationAndShutdown(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		for _, mode := range []string{"cancel", "shutdown"} {
			t.Run(version+"/"+mode, func(t *testing.T) {
				f := newEntryFixture(t)
				c := f.client(t, version, "alice")
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() {
					_, err := c.CallTool(ctx, &sdk.CallToolParams{Name: "test_only", Arguments: map[string]any{"mode": "wait"}})
					done <- err
				}()
				select {
				case <-f.entered:
				case <-time.After(5 * time.Second):
					t.Fatal("handler not entered")
				}
				if mode == "cancel" {
					cancel()
				} else {
					shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
					defer stop()
					if err := f.entry.Shutdown(shutdownCtx); err != nil {
						t.Fatalf("shutdown: %v", err)
					}
				}
				select {
				case <-f.canceled:
				case <-time.After(5 * time.Second):
					t.Fatal("handler did not receive cancellation")
				}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("call did not finish")
				}
				if mode == "shutdown" {
					req, _ := http.NewRequest("POST", f.server.URL, strings.NewReader("{}"))
					req.Header.Set("Authorization", "Bearer alice")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					resp.Body.Close()
					if resp.StatusCode != http.StatusServiceUnavailable {
						t.Fatalf("request after shutdown status %d", resp.StatusCode)
					}
				}
			})
		}
	}
}
