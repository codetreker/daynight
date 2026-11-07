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
	logger.ErrorContext(context.Background(), "private-secret", "field", "private-secret")
	if strings.Contains(logs.String(), "private-secret") || !strings.Contains(logs.String(), "MCP SDK event") {
		t.Fatal(logs.String())
	}
}
