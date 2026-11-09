package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// SDK diagnostics may include request fields, parameters, or peer errors.
// Retain the severity without forwarding those uncontrolled values to logs.
type safeSDKLog struct{ handler slog.Handler }

func (h safeSDKLog) Enabled(ctx context.Context, level slog.Level) bool {
	return h.handler.Enabled(ctx, level)
}
func (h safeSDKLog) Handle(ctx context.Context, record slog.Record) error {
	safe := slog.NewRecord(record.Time, record.Level, "MCP SDK event", 0)
	safe.AddAttrs(slog.String("component", "mcp_sdk"))
	return h.handler.Handle(ctx, safe)
}
func (h safeSDKLog) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h safeSDKLog) WithGroup(string) slog.Handler      { return h }

// SDK JSON responses are emitted as complete messages in one Write. Inspect
// protocol errors only; tool results pass directly through without buffering.
type safeSDKWriter struct {
	http.ResponseWriter
	status int
}

func (w *safeSDKWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *safeSDKWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *safeSDKWriter) Write(p []byte) (int, error) {
	if w.status >= 400 && !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		return writeSafe(w.ResponseWriter, p, []byte("MCP request rejected\n"))
	}
	trimmed := bytes.TrimSpace(p)
	if len(trimmed) == 0 || trimmed[0] != '{' && trimmed[0] != '[' {
		return w.ResponseWriter.Write(p)
	}
	if trimmed[0] == '{' {
		if safe := safeRPCError(trimmed); safe != nil {
			return writeSafe(w.ResponseWriter, p, safe)
		}
		return w.ResponseWriter.Write(p)
	}
	// Legacy batches may contain both errors and successful tool results. Walk
	// object boundaries without copying or decoding successful results.
	ranges := batchObjects(p)
	if ranges == nil {
		return w.ResponseWriter.Write(p)
	}
	start := 0
	changed := false
	for _, r := range ranges {
		safe := safeRPCError(p[r[0]:r[1]])
		if safe == nil {
			continue
		}
		changed = true
		if _, err := writeSafe(w.ResponseWriter, p[start:r[0]], p[start:r[0]]); err != nil {
			return 0, err
		}
		if _, err := writeSafe(w.ResponseWriter, p[r[0]:r[1]], safe); err != nil {
			return 0, err
		}
		start = r[1]
	}
	if !changed {
		return w.ResponseWriter.Write(p)
	}
	if _, err := writeSafe(w.ResponseWriter, p[start:], p[start:]); err != nil {
		return 0, err
	}
	return len(p), nil
}

func writeSafe(w http.ResponseWriter, original, safe []byte) (int, error) {
	n, err := w.Write(safe)
	if err == nil && n != len(safe) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return 0, err
	}
	return len(original), nil
}

func safeRPCError(p []byte) []byte {
	// The SDK's wire encoder emits result before error. Escaped text inside a
	// string cannot contain these unescaped field delimiters.
	errorAt := bytes.Index(p, []byte(`,"error":`))
	resultAt := bytes.Index(p, []byte(`,"result":`))
	if errorAt < 0 || resultAt >= 0 && resultAt < errorAt {
		return nil
	}
	var msg struct {
		ID    json.RawMessage `json:"id"`
		Error *struct {
			Code int64           `json:"code"`
			Data json.RawMessage `json:"data"`
		} `json:"error"`
	}
	if len(p) > 6*transport.MaxMCPJSONBodyBytes+(64<<10) || json.Unmarshal(p, &msg) != nil || msg.Error == nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}`)
	}
	if len(msg.ID) == 0 {
		msg.ID = json.RawMessage("null")
	}
	message := "MCP protocol error"
	switch msg.Error.Code {
	case -32700:
		message = "Parse error"
	case -32600:
		message = "Invalid request"
	case -32601:
		message = "Method not found"
	case -32602:
		message = "Invalid params"
	case -32603:
		message = "Internal error"
	case sdk.CodeUnsupportedProtocolVersion:
		message = "Unsupported protocol version"
	}
	var data any
	if msg.Error.Code == sdk.CodeUnsupportedProtocolVersion {
		var versions sdk.UnsupportedProtocolVersionData
		if json.Unmarshal(msg.Error.Data, &versions) == nil {
			var supported []string
			for _, version := range versions.Supported {
				if validProtocolVersion(version) {
					supported = append(supported, version)
				}
			}
			if !validProtocolVersion(versions.Requested) {
				versions.Requested = ""
			}
			data = sdk.UnsupportedProtocolVersionData{Supported: supported, Requested: versions.Requested}
		}
	}
	safe, err := json.Marshal(struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Error   struct {
			Code    int64  `json:"code"`
			Message string `json:"message"`
			Data    any    `json:"data,omitempty"`
		} `json:"error"`
	}{"2.0", msg.ID, struct {
		Code    int64  `json:"code"`
		Message string `json:"message"`
		Data    any    `json:"data,omitempty"`
	}{msg.Error.Code, message, data}})
	if err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}`)
	}
	return safe
}

func validProtocolVersion(value string) bool {
	if len(value) != len("2006-01-02") {
		return false
	}
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

func batchObjects(p []byte) [][2]int {
	var result [][2]int
	depth, start := 0, -1
	inString, escape := false, false
	for i, b := range p {
		if inString {
			if escape {
				escape = false
			} else if b == '\\' {
				escape = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		if b == '"' {
			inString = true
			continue
		}
		switch b {
		case '[', '{':
			if b == '{' && depth == 1 {
				start = i
			}
			depth++
		case ']', '}':
			depth--
			if b == '}' && depth == 1 && start >= 0 {
				result = append(result, [2]int{start, i + 1})
				start = -1
			}
		}
	}
	return result
}
