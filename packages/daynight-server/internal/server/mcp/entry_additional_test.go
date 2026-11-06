package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func additionalEntry(t *testing.T, logger *slog.Logger) *Entry {
	t.Helper()
	e, err := New(testAuthenticator{}, "https://daynight.test", []string{"https://client.test"}, logger)
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
	return e
}

func simpleTestTool(name string, input, output any) *sdk.Tool {
	return &sdk.Tool{Name: name, Description: "Test only", InputSchema: input, OutputSchema: output}
}
func testObjectSchema() map[string]any { return map[string]any{"type": "object"} }

func TestMCPExactJSONSchemaNumberBoundary(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var invoked atomic.Int64
	input := map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "number", "maximum": 100}}, "required": []string{"value"}}
	err := e.RegisterTool(simpleTestTool("number", input, testObjectSchema()), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		invoked.Add(1)
		return ToolResult{Data: map[string]any{"valid": true}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	c := fixture.client(t, "2026-07-28", "alice")
	for _, tc := range []struct {
		number    string
		wantError bool
	}{{"100", false}, {"100.00000000000000001", true}, {"99.99999999999999999", false}} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		r, err := c.CallTool(ctx, &sdk.CallToolParams{Name: "number", Arguments: json.RawMessage(`{"value":` + tc.number + `}`)})
		cancel()
		if err != nil {
			t.Fatalf("%s: %v", tc.number, err)
		}
		if r.IsError != tc.wantError {
			t.Fatalf("%s: error=%v result=%#v", tc.number, r.IsError, r.StructuredContent)
		}
		if tc.wantError {
			failure := object(t, structured(t, r)["error"])
			if failure["code"] != "invalid_input" {
				t.Fatalf("%s: %#v", tc.number, failure)
			}
		}
	}
	if got := invoked.Load(); got != 2 {
		t.Fatalf("handler invoked %d times, want 2", got)
	}
}

func TestMCPPreflightIncludesProtocolMethodAndName(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodOptions, "http://example.test/mcp", nil)
	request.Header.Set("Origin", "https://client.test")
	request.Header.Set("Access-Control-Request-Method", "POST")
	request.Header.Set("Access-Control-Request-Headers", "authorization, content-type, mcp-method, mcp-name")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != "https://client.test" {
		t.Fatalf("preflight status %d, headers %#v", response.Code, response.Header())
	}
	allowed := strings.ToLower(response.Header().Get("Access-Control-Allow-Headers"))
	for _, header := range []string{"authorization", "content-type", "mcp-method", "mcp-name"} {
		found := false
		for _, part := range strings.Split(allowed, ",") {
			if strings.TrimSpace(part) == header {
				found = true
			}
		}
		if !found {
			t.Errorf("preflight did not allow %s: %s", header, allowed)
		}
	}
	if response.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Error("preflight must not allow credentials")
	}
}

type failedResponseWriter struct {
	header http.Header
	status int
}

func (w *failedResponseWriter) Header() http.Header       { return w.header }
func (w *failedResponseWriter) WriteHeader(status int)    { w.status = status }
func (w *failedResponseWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestMCPResponseWriteFailureLogsCompletionAndDelivery(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	e := additionalEntry(t, logger)
	err := e.RegisterTool(simpleTestTool("write", testObjectSchema(), testObjectSchema()), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: map[string]any{"id": "created"}, Outcome: "changed", WriteOutcome: "confirmed"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://example.test/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write","arguments":{}}}`))
	request.Header.Set("Authorization", "Bearer alice")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	request.Header.Set("X-Request-ID", "delivery-test")
	writer := &failedResponseWriter{header: make(http.Header)}
	httpx.RequestLogging(logger, e).ServeHTTP(writer, request)
	var completed, delivery bool
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var item map[string]any
		if err := json.Unmarshal(line, &item); err != nil {
			t.Fatalf("invalid log: %s", line)
		}
		if item["request_id"] != "delivery-test" {
			continue
		}
		switch item["msg"] {
		case "MCP tool completed":
			completed = item["outcome"] == "changed" && item["write_outcome"] == "confirmed"
		case "MCP response delivery failed":
			delivery = item["phase"] == "delivery"
		}
	}
	if !completed || !delivery {
		t.Fatalf("missing completion or delivery fact: %s", logs.String())
	}
}

func TestMCPOutputEncodingFailurePreservesChangedCompletion(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	err := e.RegisterTool(simpleTestTool("changed", testObjectSchema(), testObjectSchema()), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: make(chan int), Outcome: "changed", Refs: map[string]any{"id": "original"}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	c := fixture.client(t, "2025-11-25", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := c.CallTool(ctx, &sdk.CallToolParams{Name: "changed", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsError {
		t.Fatal("expected output failure")
	}
	failure := object(t, structured(t, r)["error"])
	if failure["code"] != "internal_error" || failure["requestId"] != "test-request" || failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" || object(t, failure["refs"])["id"] != "original" {
		t.Fatalf("failure: %#v", failure)
	}
}

func TestMCPOutputFailureWithUnencodableRefsPreservesCompletion(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	err := e.RegisterTool(simpleTestTool("bad_refs", testObjectSchema(), testObjectSchema()), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: make(chan int), Outcome: "changed", Refs: map[string]any{"id": make(chan int)}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	c := fixture.client(t, "2025-11-25", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := c.CallTool(ctx, &sdk.CallToolParams{Name: "bad_refs", Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("expected structured error, got %v", err)
	}
	if !r.IsError {
		t.Fatal("expected output failure")
	}
	failure := object(t, structured(t, r)["error"])
	if failure["code"] != "internal_error" || failure["requestId"] != "test-request" || failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" {
		t.Fatalf("failure: %#v", failure)
	}
}

func TestMCPRejectsOutputSchemaWithoutCommonErrorEnvelope(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	schemas := []any{
		map[string]any{"type": "object", "properties": map[string]any{"data": map[string]any{"type": "object"}}, "required": []string{"data"}, "additionalProperties": false},
		map[string]any{"type": "object", "properties": map[string]any{"error": map[string]any{"type": "object", "properties": map[string]any{"code": map[string]any{"const": "internal_error"}}, "required": []string{"code"}}}, "required": []string{"error"}},
	}
	for i, schema := range schemas {
		err := e.RegisterTool(simpleTestTool("bad_output_schema", testObjectSchema(), schema), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) { return ToolResult{}, nil })
		if err == nil {
			t.Errorf("accepted output schema %d excluding a common error envelope", i)
		}
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	c := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := c.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) != 0 {
		t.Fatalf("invalid tool discoverable: %#v", list.Tools)
	}
}

func TestMCPHTTPPublicHostViaLoopback(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	for _, tc := range []struct {
		name, host string
		accepted   bool
	}{{"public", "daynight.test", true}, {"foreign", "evil.test", false}} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Host = tc.host
			req.Header.Set("Authorization", "Bearer alice")
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("MCP-Protocol-Version", "2025-11-25")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if tc.accepted {
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("valid public Host rejected: %d %s", resp.StatusCode, body)
				}
				var result struct {
					Result struct {
						Tools []any `json:"tools"`
					} `json:"result"`
					Error any `json:"error"`
				}
				if err := json.Unmarshal(body, &result); err != nil || result.Error != nil || result.Result.Tools == nil {
					t.Fatalf("invalid discovery response: %s (%v)", body, err)
				}
			} else if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("foreign Host accepted: %d %s", resp.StatusCode, body)
			}
		})
	}
}

func TestMCPHTTPValidatesUUIDAndDateTimeFormats(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var invoked atomic.Int64
	input := map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string", "format": "uuid"}}, "required": []string{"id"}}
	output := map[string]any{"type": "object", "properties": map[string]any{"data": map[string]any{"type": "object", "properties": map[string]any{"createdAt": map[string]any{"type": "string", "format": "date-time"}}, "required": []string{"createdAt"}}}}
	err := e.RegisterTool(simpleTestTool("formats", input, output), BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		invoked.Add(1)
		return ToolResult{Data: map[string]any{"createdAt": "not-a-date"}, Outcome: "changed"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	c := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := c.CallTool(ctx, &sdk.CallToolParams{Name: "formats", Arguments: map[string]any{"id": "not-a-uuid"}})
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsError || object(t, structured(t, r)["error"])["code"] != "invalid_input" {
		t.Fatalf("invalid UUID result %#v", r)
	}
	if invoked.Load() != 0 {
		t.Fatal("invalid UUID reached handler")
	}
	r, err = c.CallTool(ctx, &sdk.CallToolParams{Name: "formats", Arguments: map[string]any{"id": "47c5152b-5c1c-3947-9748-2c07bed34b5a"}})
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsError {
		t.Fatalf("invalid date-time output accepted: %#v", r)
	}
	failure := object(t, structured(t, r)["error"])
	if failure["code"] != "internal_error" || failure["requestId"] != "test-request" || failure["phase"] != "output" || failure["writeOutcome"] != "confirmed" {
		t.Fatalf("invalid output failure %#v", failure)
	}
	if invoked.Load() != 1 {
		t.Fatalf("handler invoked %d times", invoked.Load())
	}
}

func TestMCPHTTPUnpairedSurrogateReachesRawHandler(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	observed := make(chan json.RawMessage, 1)
	err := e.RegisterTool(simpleTestTool("unicode_probe", testObjectSchema(), testObjectSchema()), BudgetControl, func(_ context.Context, _ RequestActor, raw json.RawMessage) (ToolResult, error) {
		observed <- append(json.RawMessage(nil), raw...)
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unicode_probe","arguments":{"name":"\ud800","properties":{"value":"\ud800"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	select {
	case raw := <-observed:
		if !bytes.Contains(raw, []byte(`"name":"\ud800"`)) || !bytes.Contains(raw, []byte(`"value":"\ud800"`)) {
			t.Fatalf("raw arguments lost original surrogate escapes: %s", raw)
		}
		var input struct {
			Name       string                     `json:"name"`
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(raw, &input); err != nil || input.Name != "\ufffd" || string(input.Properties["value"]) != `"\ud800"` {
			t.Fatalf("decoded input: %+v, %v", input, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not receive arguments")
	}
}

func TestMCPHTTPTypedToolUnicodeAndDecode(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	type input struct {
		Name       string          `json:"name"`
		Count      int             `json:"count"`
		Properties json.RawMessage `json:"properties"`
	}
	var invoked atomic.Int64
	observed := make(chan input, 1)
	schema := map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}, "count": map[string]any{"type": "number"}, "properties": map[string]any{"type": "object"}}, "required": []string{"name", "count", "properties"}}
	err := RegisterTypedTool(e, simpleTestTool("typed", schema, testObjectSchema()), BudgetControl, func(_ context.Context, _ RequestActor, v input) (ToolResult, error) {
		invoked.Add(1)
		observed <- v
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	}, "name")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), e))
	t.Cleanup(server.Close)
	send := func(arguments string) map[string]any {
		t.Helper()
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"typed","arguments":` + arguments + `}}`
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer alice")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		req.Header.Set("X-Request-ID", "typed-request")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		content, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d: %s", resp.StatusCode, content)
		}
		var decoded map[string]any
		if err := json.Unmarshal(content, &decoded); err != nil {
			t.Fatalf("decode %s: %v", content, err)
		}
		return object(t, decoded["result"])
	}
	for _, tc := range []struct{ name, args string }{
		{"unpaired", `{"name":"\ud800","count":1,"properties":{}}`},
		{"decode", `{"name":"valid","count":1.5,"properties":{}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := send(tc.args)
			if r["isError"] != true {
				t.Fatalf("expected error: %#v", r)
			}
			failure := object(t, object(t, r["structuredContent"])["error"])
			if failure["code"] != "invalid_input" || failure["requestId"] != "typed-request" {
				t.Fatalf("input failure: %#v", failure)
			}
			if invoked.Load() != 0 {
				t.Fatal("invalid arguments reached handler")
			}
		})
	}
	rawProperties := `{"n":900719925474099312345,"text":"\ud800","nested":[null,false]}`
	result := send(`{"name":"valid \ud83d\ude00","count":1,"properties":` + rawProperties + `}`)
	if result["isError"] == true {
		t.Fatalf("valid input rejected: %#v", result)
	}
	select {
	case v := <-observed:
		if v.Name != "valid 😀" || v.Count != 1 || string(v.Properties) != rawProperties {
			t.Fatalf("changed typed input: %+v, properties=%s", v, v.Properties)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not receive valid input")
	}
	if invoked.Load() != 1 {
		t.Fatalf("handler invoked %d times", invoked.Load())
	}
}
