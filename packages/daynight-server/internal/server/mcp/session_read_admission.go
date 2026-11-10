package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	sdkjson "github.com/segmentio/encoding/json"
)

func sessionReadLimit(message string) error {
	return &model.Fault{Code: "resource_limit_exceeded", Message: message}
}

// Only history reads have a complete HTTP response budget. A mixed batch could
// exceed it even if each individual result fits, so history calls stand alone.
func sessionReadAdmission(body []byte, requestID, headerName string) (bool, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return false, nil
	}
	batch := trimmed[0] == '['
	var messages []json.RawMessage
	if batch {
		if json.Unmarshal(trimmed, &messages) != nil {
			return false, nil
		}
	} else {
		messages = []json.RawMessage{trimmed}
	}
	for _, raw := range messages {
		message, err := jsonrpc.DecodeMessage(raw)
		if err != nil {
			continue
		}
		call, ok := message.(*jsonrpc.Request)
		if !ok {
			continue
		}
		selected := headerName == "task_session_read" || headerName == "task_session_entry"
		if call.Method == "tools/call" {
			// Match the SDK's complete parameter type and decoder, including exact
			// field names, duplicate fields and null string values. The outer SDK
			// decoder has already checked the complete message's nesting depth.
			var params sdk.CallToolParamsRaw
			decoder := sdkjson.NewDecoder(bytes.NewReader(call.Params))
			decoder.DontMatchCaseInsensitiveStructFields()
			_ = decoder.Decode(&params)
			selected = selected || params.Name == "task_session_read" || params.Name == "task_session_entry"
		}
		if !selected {
			continue
		}
		if len(messages) != 1 {
			return true, sessionReadLimit("Send each Session history read in a separate request; multi-call batches containing history reads are not supported.")
		}
		actor := RequestActor{RequestID: requestID, rpcResponseID: call.ID.Raw(), rpcModern: true, rpcBatch: batch}
		refs := map[string]any{"projectId": "00000000-0000-4000-8000-000000000000", "taskId": "00000000-0000-4000-8000-000000000000", "sessionId": "00000000-0000-4000-8000-000000000000"}
		overhead, err := workResponseOverhead(actor, refs)
		if err != nil {
			return true, err
		}
		if overhead >= sp.MaxHistoryResponseBytes {
			return true, sessionReadLimit("The Session history response envelope exceeds its limit; use a shorter JSON-RPC request ID.")
		}
		return true, nil
	}
	return false, nil
}

// A history response can contain either data or an error. Bounded buffering
// covers both and keeps split SDK writes from publishing a partial result
// before an overflow is known. Other tools retain their ordinary streaming path.
type sessionReadResponseWriter struct {
	http.ResponseWriter
	body     []byte
	status   int
	exceeded bool
}

func (w *sessionReadResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *sessionReadResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *sessionReadResponseWriter) Flush()            {}
func (w *sessionReadResponseWriter) FlushError() error { return nil }
func (w *sessionReadResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if !w.exceeded {
		if len(p) > sp.MaxHistoryResponseBytes-len(w.body) {
			w.exceeded = true
			w.body = nil
		} else {
			if w.body == nil && len(p) > 0 {
				w.body = make([]byte, 0, sp.MaxHistoryResponseBytes)
			}
			w.body = append(w.body, p...)
		}
	}
	return len(p), nil
}
func (w *sessionReadResponseWriter) finish(r *http.Request) error {
	if r.Context().Err() != nil {
		return nil
	}
	body := w.body
	if w.exceeded {
		body, _ = json.Marshal(envelope{Error: &envelopeError{Code: "resource_limit_exceeded", Message: "The encoded Session history response exceeds its limit.", RequestID: httpx.RequestID(r.Context())}})
		w.status = http.StatusConflict
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Type", "application/json")
	}
	if w.status != 0 {
		w.ResponseWriter.WriteHeader(w.status)
	}
	if len(body) == 0 {
		return nil
	}
	n, err := w.ResponseWriter.Write(body)
	if err == nil && n != len(body) {
		err = io.ErrShortWrite
	}
	return err
}
