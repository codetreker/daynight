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
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func TestSessionReadHTTPAdmissionBoundsErrorsAndRejectsMultiCallBatches(t *testing.T) {
	for _, test := range []struct {
		name, id string
		extra    map[string]any
	}{
		{name: "oversized ID", id: strings.Repeat("x", sp.MaxHistoryResponseBytes)},
		{name: "escaped ID", id: strings.Repeat("<", 50000)},
		{name: "second history", id: "page", extra: rpcTaskCall("entry", "2025-11-25", "task_session_entry", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "sessionId": testUserID, "cursor": "body"})},
		{name: "unknown tool", id: "page", extra: rpcTaskCall("other", "2025-11-25", "unknown_tool", map[string]any{})},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newSessionReadFixture(t)
			calls := 0
			mock := sessionReadMock{t: t, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
				calls++
				return ss.NewReadResult(sessionReadPage(), nil), nil
			}, entry: func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
				calls++
				return nil, &model.Fault{Code: "invalid_input", Message: "invalid cursor"}
			}}
			if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
				t.Fatal(err)
			}
			call := rpcTaskCall(test.id, "2025-11-25", "task_session_read", sessionReadArgs())
			var body any = call
			if test.extra != nil {
				body = []any{call, test.extra}
			}
			resp, raw := rpcTaskRequest(t, f.server.URL, "2025-11-25", body)
			var result struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(raw, &result) != nil || resp.StatusCode != http.StatusConflict || len(raw) > sp.MaxHistoryResponseBytes || result.Error.Code != "resource_limit_exceeded" || calls != 0 {
				t.Fatalf("history admission: status=%d bytes=%d error=%s calls=%d", resp.StatusCode, len(raw), result.Error.Code, calls)
			}
		})
	}
}

func TestSessionReadHTTPResponseBoundsLargeServiceErrors(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
		return nil, &model.Fault{Code: "invalid_input", Message: strings.Repeat("<&", sp.MaxHistoryResponseBytes)}
	}}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	req := sessionReadRequest(t, t.Context(), f.server.URL, "2026-07-28", "failure", "task_session_read", false)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &result) != nil || resp.StatusCode != http.StatusConflict || len(raw) > sp.MaxHistoryResponseBytes || result.Error.Code != "resource_limit_exceeded" {
		t.Fatalf("error response: status=%d bytes=%d error=%s", resp.StatusCode, len(raw), result.Error.Code)
	}
}

type sessionReadShortWriter struct {
	header http.Header
	writes int
}

func (w *sessionReadShortWriter) Header() http.Header         { return w.header }
func (w *sessionReadShortWriter) WriteHeader(int)             {}
func (w *sessionReadShortWriter) Write(p []byte) (int, error) { w.writes++; return len(p) - 1, nil }

func TestSessionReadResponseWaitsForCompleteEncodingAndHandlesShortWrites(t *testing.T) {
	for _, overflow := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact", true: "overflow"}[overflow], func(t *testing.T) {
			target := httptest.NewRecorder()
			w := &sessionReadResponseWriter{ResponseWriter: target}
			w.WriteHeader(http.StatusOK)
			first := strings.Repeat("a", sp.MaxHistoryResponseBytes-1)
			if n, err := io.WriteString(w, first); err != nil || n != len(first) {
				t.Fatal(n, err)
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Fatal(err)
			}
			second := "b"
			if overflow {
				second = "bc"
			}
			if _, err := io.WriteString(w, second); err != nil {
				t.Fatal(err)
			}
			if target.Body.Len() != 0 || cap(w.body) > sp.MaxHistoryResponseBytes {
				t.Fatal("partial output or excess buffer capacity")
			}
			if err := w.finish(httptest.NewRequest(http.MethodPost, "/mcp", nil)); err != nil {
				t.Fatal(err)
			}
			if overflow {
				if target.Code != http.StatusConflict || target.Body.Len() >= sp.MaxHistoryResponseBytes || strings.Contains(target.Body.String(), "aaaa") {
					t.Fatal("overflow emitted partial success")
				}
			} else if target.Code != http.StatusOK || target.Body.String() != first+second {
				t.Fatal("split response changed")
			}
		})
	}
	target := &sessionReadShortWriter{header: make(http.Header)}
	w := &sessionReadResponseWriter{ResponseWriter: target}
	_, _ = w.Write([]byte("result"))
	if err := w.finish(httptest.NewRequest(http.MethodPost, "/mcp", nil)); !errors.Is(err, io.ErrShortWrite) || target.writes != 1 {
		t.Fatalf("short write: %v calls=%d", err, target.writes)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	target = &sessionReadShortWriter{header: make(http.Header)}
	w = &sessionReadResponseWriter{ResponseWriter: target}
	_, _ = w.Write([]byte("result"))
	if err := w.finish(httptest.NewRequest(http.MethodPost, "/mcp", nil).WithContext(ctx)); err != nil || target.writes != 0 {
		t.Fatal("canceled response was delivered")
	}
}

func TestSessionReadLegacyBatchProtocolErrorRemainsBounded(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	call := rpcTaskCall(strings.Repeat("<", 30000), "2025-11-25", "task_session_read", sessionReadArgs())
	call["params"].(map[string]any)["arguments"] = []any{}
	resp, raw := rpcTaskRequest(t, f.server.URL, "", []any{call})
	var result []map[string]any
	if resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &result) != nil || len(result) != 1 || len(raw) > sp.MaxHistoryResponseBytes || result[0]["error"] == nil {
		t.Fatalf("legacy protocol error status=%d bytes=%d", resp.StatusCode, len(raw))
	}
}

func TestSessionReadAdmissionUsesSDKCaseAndDuplicateFieldSemantics(t *testing.T) {
	for _, params := range []string{
		`"params":{"name":"task_session_read","arguments":{"projectId":"` + testProjectID + `","taskId":"` + testTargetID + `","sessionId":"` + testUserID + `"}},"Params":{"name":"other"}`,
		`"params":[],"params":{"name":"task_session_read","arguments":{"projectId":"` + testProjectID + `","taskId":"` + testTargetID + `","sessionId":"` + testUserID + `"}}`,
		`"params":{"name":"task_session_read","name":null,"arguments":{"projectId":"` + testProjectID + `","taskId":"` + testTargetID + `","sessionId":"` + testUserID + `"}}`,
	} {
		t.Run(params[:14], func(t *testing.T) {
			f := newSessionReadFixture(t)
			mock := sessionReadMock{t: t, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
				return nil, &model.Fault{Code: "invalid_input", Message: strings.Repeat("x", sp.MaxHistoryResponseBytes)}
			}}
			if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
				t.Fatal(err)
			}
			raw := []byte(`{"jsonrpc":"2.0","id":"case-sensitive","method":"tools/call",` + params + `}`)
			original := string(raw)
			resp, body := rpcTaskRawRequest(t, f.server.URL, "2025-11-25", raw)
			if resp.StatusCode != http.StatusConflict || len(body) > sp.MaxHistoryResponseBytes || !strings.Contains(string(body), `"code":"resource_limit_exceeded"`) || string(raw) != original {
				t.Fatalf("SDK interpretation escaped bounded response: status=%d bytes=%d", resp.StatusCode, len(body))
			}
		})
	}
}

func TestSessionReadAdmissionBoundsInvalidArgumentsAndHeaderMismatch(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	args := sessionReadArgs()
	args["projectId"] = strings.Repeat("<", 100000)
	args["refs"] = strings.Repeat("x", 100000)
	resp, raw := rpcTaskRequest(t, f.server.URL, "2025-11-25", rpcTaskCall("invalid", "2025-11-25", "task_session_read", args))
	if resp.StatusCode != http.StatusOK || len(raw) > sp.MaxHistoryResponseBytes || !strings.Contains(string(raw), `"code":"invalid_input"`) {
		t.Fatalf("invalid input: status=%d bytes=%d", resp.StatusCode, len(raw))
	}
	req := sessionReadRequest(t, t.Context(), f.server.URL, "2026-07-28", strings.Repeat("x", sp.MaxHistoryResponseBytes), "other", false)
	req.Header.Set("MCP-Name", "task_session_read")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err = io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusConflict || len(raw) > sp.MaxHistoryResponseBytes || !strings.Contains(string(raw), `"code":"resource_limit_exceeded"`) {
		t.Fatalf("header mismatch: status=%d bytes=%d", resp.StatusCode, len(raw))
	}
}

func TestSessionReadAdmissionLeavesOtherReadsComplete(t *testing.T) {
	f := newSessionReadFixture(t)
	definition := sessionReadToolDefinition("current")
	definition.Name = "ordinary_read"
	definition.OutputSchema.(map[string]any)["properties"].(map[string]any)["data"] = readString()
	if err := registerTypedReadTool(f.entry, definition, BudgetControl, func(context.Context, RequestActor, sessionReadInput) (ToolResult, error) {
		return ToolResult{Data: strings.Repeat("x", sp.MaxHistoryResponseBytes+1000)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	resp, raw := rpcTaskRequest(t, f.server.URL, "2025-11-25", rpcTaskCall("ordinary", "2025-11-25", "ordinary_read", map[string]any{"projectId": testProjectID, "taskId": testTargetID}))
	if resp.StatusCode != http.StatusOK || len(raw) <= sp.MaxHistoryResponseBytes || bytes.Contains(raw, []byte(`"isError":true`)) {
		t.Fatalf("ordinary read acquired history budget: status=%d bytes=%d", resp.StatusCode, len(raw))
	}
}
