package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSDKProtocolErrorsDoNotEchoInput(t *testing.T) {
	var logs bytes.Buffer
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, slog.New(slog.NewTextHandler(&logs, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Shutdown(context.Background()) })
	for _, tc := range []struct {
		name, version, body string
		status              int
		code                int
	}{
		{"version", "", `{"jsonrpc":"private-secret","id":1,"method":"tools/list"}`, 400, 0},
		{"method", "", `{"jsonrpc":"2.0","id":1,"method":"private-secret"}`, 400, 0},
		{"new method", "2026-07-28", `{"jsonrpc":"2.0","id":1,"method":"private-secret"}`, 404, -32601},
		{"params", "2025-11-25", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":123,"private":"private-secret"}}`, 200, 0},
		{"meta", "2026-07-28", `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"private-secret"}}}`, 400, -32020},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := inputRequest(io.NopCloser(strings.NewReader(tc.body)))
			if tc.version != "" {
				r.Header.Set("MCP-Protocol-Version", tc.version)
			}
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			if w.Code != tc.status || strings.Contains(w.Body.String(), "private-secret") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			if tc.name != "version" && tc.name != "method" {
				var value struct {
					JSONRPC string `json:"jsonrpc"`
					ID      int    `json:"id"`
					Error   struct {
						Code int `json:"code"`
					} `json:"error"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil || value.JSONRPC != "2.0" || value.ID != 1 || value.Error.Code != tc.code {
					t.Fatalf("RPC error %s: %v", w.Body, err)
				}
			}
			if len(e.input) != 0 {
				t.Fatal("input slot retained")
			}
		})
	}
	if strings.Contains(logs.String(), "private-secret") {
		t.Fatalf("secret leaked in logs: %s", logs.String())
	}
}

func TestSDKUnsupportedVersionRetainsSafeNegotiationData(t *testing.T) {
	var logs bytes.Buffer
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, slog.New(slog.NewTextHandler(&logs, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Shutdown(context.Background()) })
	for _, tc := range []struct{ requested, want string }{
		{"2027-01-01", "2027-01-01"},
		{"private-secret", ""},
	} {
		t.Run(tc.requested, func(t *testing.T) {
			body := `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"` + tc.requested + `","io.modelcontextprotocol/clientCapabilities":{}}}}`
			r := inputRequest(io.NopCloser(strings.NewReader(body)))
			r.Header.Set("MCP-Protocol-Version", tc.requested)
			r.Header.Set("MCP-Method", "server/discover")
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			var response struct {
				ID    int `json:"id"`
				Error struct {
					Code int                                `json:"code"`
					Data sdk.UnsupportedProtocolVersionData `json:"data"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != http.StatusBadRequest || response.ID != 1 || response.Error.Code != sdk.CodeUnsupportedProtocolVersion || response.Error.Data.Requested != tc.want || !reflect.DeepEqual(response.Error.Data.Supported, []string{"2026-07-28", "2025-11-25"}) {
				t.Fatalf("response %d %s: %v", w.Code, w.Body, err)
			}
			if strings.Contains(w.Body.String(), "private-secret") || len(e.input) != 0 {
				t.Fatalf("unsafe output or retained input: %s", w.Body)
			}
		})
	}
	if strings.Contains(logs.String(), "private-secret") {
		t.Fatal("secret in logs")
	}
}

func TestSafeSDKWriterKeepsResultsAndPropagatesFailures(t *testing.T) {
	batch := `[{"jsonrpc":"2.0","id":1,"result":{"error":{"message":"tool result"}}},{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"private-secret"}}]`
	w := httptest.NewRecorder()
	safe := &safeSDKWriter{ResponseWriter: w}
	if n, err := safe.Write([]byte(batch)); err != nil || n != len(batch) {
		t.Fatalf("write = %d, %v", n, err)
	}
	if strings.Contains(w.Body.String(), "private-secret") || !strings.Contains(w.Body.String(), `"message":"tool result"`) {
		t.Fatalf("batch = %s", w.Body)
	}
	var decoded []struct {
		ID    int `json:"id"`
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &decoded); err != nil || len(decoded) != 2 || decoded[1].ID != 2 || decoded[1].Error == nil || decoded[1].Error.Code != -32602 {
		t.Fatalf("batch = %s, %v", w.Body, err)
	}
	failure := &failedResponseWriter{header: make(http.Header)}
	safe = &safeSDKWriter{ResponseWriter: failure}
	if _, err := safe.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"private-secret"}}`)); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write failure = %v", err)
	}
}

func TestSafeSDKLogDiscardsUntrustedDiagnostics(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(safeSDKLog{handler: slog.NewTextHandler(&logs, nil)})
	logger.With("context", "private-secret").WithGroup("private-secret").ErrorContext(context.Background(), "private-secret", "field", "private-secret")
	if strings.Contains(logs.String(), "private-secret") || !strings.Contains(logs.String(), "MCP SDK event") {
		t.Fatal(logs.String())
	}
}

type sdkDeadlineWriter struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (w *sdkDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func TestSafeSDKWriterResponseController(t *testing.T) {
	underlying := &sdkDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	w := &safeSDKWriter{ResponseWriter: &noStoreWriter{ResponseWriter: underlying}}
	want := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(want); err != nil || underlying.deadline != want {
		t.Fatalf("read deadline = %v, %v", underlying.deadline, err)
	}
	if err := controller.Flush(); err != nil || !underlying.Flushed {
		t.Fatalf("flush = %v, flushed = %v", err, underlying.Flushed)
	}
}

type failingSDKWriter struct {
	*httptest.ResponseRecorder
	failAt, writes int
	short          bool
}

func (w *failingSDKWriter) Write(p []byte) (int, error) {
	w.writes++
	if w.writes == w.failAt {
		if w.short {
			return 0, nil
		}
		return 0, io.ErrClosedPipe
	}
	return w.ResponseRecorder.Write(p)
}

func TestSafeSDKWriterBatchDeliveryFailure(t *testing.T) {
	input := `[{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"private-secret"}}]`
	for _, failAt := range []int{1, 2, 3} {
		t.Run(string(rune('0'+failAt)), func(t *testing.T) {
			sink := &failingSDKWriter{ResponseRecorder: httptest.NewRecorder(), failAt: failAt}
			w := &safeSDKWriter{ResponseWriter: sink}
			if _, err := w.Write([]byte(input)); !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("write %d: %v", failAt, err)
			}
		})
	}
	sink := &failingSDKWriter{ResponseRecorder: httptest.NewRecorder(), failAt: 2, short: true}
	if _, err := (&safeSDKWriter{ResponseWriter: sink}).Write([]byte(input)); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write: %v", err)
	}
}

func TestSafeSDKWriterPassesSuccessfulBodies(t *testing.T) {
	for _, body := range []string{
		``, `ordinary`, `[]`,
		`{"jsonrpc":"2.0","id":1,"result":{"error":{"message":"tool result"}}}`,
		`[{"jsonrpc":"2.0","id":1,"result":{"text":"unchanged"}}]`,
	} {
		w := httptest.NewRecorder()
		if n, err := (&safeSDKWriter{ResponseWriter: w}).Write([]byte(body)); err != nil || n != len(body) || w.Body.String() != body {
			t.Fatalf("body %q: n=%d err=%v got=%q", body, n, err, w.Body.String())
		}
	}
}

func TestSafeSDKWriterPreservesProtocolErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		code    int
		message string
	}{
		{-32700, "Parse error"}, {-32600, "Invalid request"}, {-32601, "Method not found"}, {-32602, "Invalid params"}, {-32603, "Internal error"},
	} {
		body, err := json.Marshal(struct {
			JSONRPC string `json:"jsonrpc"`
			Error   struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}{"2.0", struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}{tc.code, "private-secret"}})
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		if _, err := (&safeSDKWriter{ResponseWriter: w}).Write(body); err != nil {
			t.Fatal(err)
		}
		var result struct {
			ID    any `json:"id"`
			Error struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.ID != nil || result.Error.Code != tc.code || result.Error.Message != tc.message || strings.Contains(w.Body.String(), "private-secret") {
			t.Fatalf("response %s: %v", w.Body, err)
		}
	}
}
