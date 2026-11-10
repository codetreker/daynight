package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type sessionSendMock struct {
	t      *testing.T
	submit func(context.Context, model.Principal, string, string, string, sp.Command) (sp.Operation, error)
	read   func(context.Context, model.Principal, string, string, string, string) (sessioncore.TaskOperationResult, error)
}

func (s sessionSendMock) Submit(ctx context.Context, p model.Principal, project, task, id string, c sp.Command) (sp.Operation, error) {
	if s.submit == nil {
		s.t.Error("unexpected Submit")
		return sp.Operation{}, errors.New("unexpected Submit")
	}
	return s.submit(ctx, p, project, task, id, c)
}
func (s sessionSendMock) TaskOperation(ctx context.Context, p model.Principal, project, task, id, operation string) (sessioncore.TaskOperationResult, error) {
	if s.read == nil {
		s.t.Error("unexpected TaskOperation")
		return sessioncore.TaskOperationResult{}, errors.New("unexpected TaskOperation")
	}
	return s.read(ctx, p, project, task, id, operation)
}
func sendArguments() map[string]any {
	return map[string]any{"projectId": testProjectID, "taskId": testTargetID, "sessionId": "11111111-1111-4111-8111-111111111111", "operationId": "22222222-2222-4222-8222-222222222222", "claimId": "33333333-3333-4333-8333-333333333333", "executionGeneration": "1", "expectedTurnId": nil, "text": "/literal\r\n消息😀\n"}
}
func sendReceipt(c sp.Command) sp.Operation {
	return sp.Operation{Fence: c.Fence, Protocol: sp.Protocol, OperationID: c.OperationID, Kind: c.Kind, State: "accepted"}
}

func TestSessionSendModulePublishesStrictToolsAndPreservesIntent(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	args := sendArguments()
	ops := sessionSendMock{t: t, submit: func(ctx context.Context, p model.Principal, project, task, id string, c sp.Command) (sp.Operation, error) {
		calls++
		var payload sp.SendMessage
		if err := json.Unmarshal(c.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if ctx.Err() != nil || p.UserID != "alice" || p.Kind != model.PATCredential || project != testProjectID || task != testTargetID || id != args["sessionId"] || c.SessionID != id || c.ClaimID != args["claimId"] || c.OperationID != args["operationId"] || c.ExecutionGeneration != "1" || c.Kind != "send_message" || payload.ExpectedTurnID != nil || len(payload.Content) != 1 || payload.Content[0].Text != args["text"] {
			t.Errorf("send changed input: %+v %+v %+v", p, c, payload)
		}
		return sendReceipt(c), nil
	}}
	if err := RegisterSessionTools(f.entry, SessionSendModule(ops)); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_send", Arguments: args})
	if err != nil || result.IsError || calls != 1 {
		t.Fatalf("send result=%#v %v calls=%d", result, err, calls)
	}
	validateDiscoveredResult(t, client, "task_session_send", result)
	env := structured(t, result)
	meta := object(t, env["meta"])
	if meta["writeOutcome"] != "confirmed" || meta["phase"] != "commit" || object(t, meta["refs"])["operationId"] != args["operationId"] || object(t, object(t, env["data"])["operation"])["state"] != "accepted" {
		t.Fatalf("receipt facts: %#v", env)
	}
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name == "task_session_send" || tool.Name == "task_session_operation" {
			if object(t, tool.InputSchema)["additionalProperties"] != false || object(t, tool.OutputSchema)["additionalProperties"] != false {
				t.Fatal("Session schema is not strict")
			}
		}
	}
	for _, invalid := range []string{"missing turn", "extra epoch", "empty", "blank", "NUL", "body bytes", "encoded bytes", "surrogate", "invalid UTF-8"} {
		t.Run(invalid, func(t *testing.T) {
			in := sendArguments()
			switch invalid {
			case "missing turn":
				delete(in, "expectedTurnId")
			case "extra epoch":
				in["connectionEpoch"] = "2"
			case "empty":
				in["text"] = ""
			case "blank":
				in["text"] = " \t\r\n"
			case "NUL":
				in["text"] = "x\x00"
			case "body bytes":
				in["text"] = strings.Repeat("😀", (1<<20)/4+1)
			case "encoded bytes":
				in["text"] = strings.Repeat("\x01", 400000)
			}
			var input any = in
			if invalid == "surrogate" || invalid == "invalid UTF-8" {
				raw, _ := json.Marshal(in)
				text := `"text":"\ud800"`
				if invalid == "invalid UTF-8" {
					text = "\"text\":\"" + string([]byte{0xff}) + "\""
				}
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(raw, &fields)
				delete(fields, "text")
				base, _ := json.Marshal(fields)
				input = json.RawMessage(string(base[:len(base)-1]) + "," + text + "}")
			}
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_send", Arguments: input})
			if err != nil || !result.IsError || calls != 1 {
				t.Fatalf("invalid input reached Submit: %#v %v calls=%d", result, err, calls)
			}
		})
	}
}

func TestSessionOperationReadRetainsOriginalRefsAndUnknownAbsence(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "historical", true: "not found"}[missing], func(t *testing.T) {
			f := newEntryFixture(t)
			args := sendArguments()
			for _, key := range []string{"claimId", "executionGeneration", "expectedTurnId", "text"} {
				delete(args, key)
			}
			calls := 0
			ops := sessionSendMock{t: t, read: func(ctx context.Context, p model.Principal, project, task, id, operation string) (sessioncore.TaskOperationResult, error) {
				calls++
				if ctx.Err() != nil || p.UserID != "alice" || project != testProjectID || task != testTargetID || id != args["sessionId"] || operation != args["operationId"] {
					t.Error("read target changed")
				}
				if missing {
					return sessioncore.TaskOperationResult{}, &model.Fault{Code: "not_found", Message: "missing", Cause: model.ErrNotFound}
				}
				return sessioncore.TaskOperationResult{Operation: sp.Operation{Fence: sp.Fence{SessionID: id, ClaimID: "33333333-3333-4333-8333-333333333333", ExecutionGeneration: "1"}, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "provider_accepted"}, CurrentBinding: false}, nil
			}}
			if err := RegisterSessionTools(f.entry, SessionSendModule(ops)); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_operation", Arguments: args})
			if err != nil || result.IsError != missing || calls != 1 {
				t.Fatalf("read result %#v %v", result, err)
			}
			validateDiscoveredResult(t, client, "task_session_operation", result)
			env := structured(t, result)
			key := "meta"
			if missing {
				key = "error"
			}
			facts := object(t, env[key])
			if facts["writeOutcome"] != nil || object(t, facts["refs"])["operationId"] != args["operationId"] {
				t.Fatalf("read became a mutation/lost refs: %#v", env)
			}
			if missing && (facts["code"] != "not_found" || !strings.Contains(facts["message"].(string), "unknown")) {
				t.Fatalf("absence is not unknown: %#v", facts)
			}
			if !missing && object(t, env["data"])["currentBinding"] != false {
				t.Fatalf("historical binding changed: %#v", env)
			}
		})
	}
}

func TestSessionSubmitCompletionAndOutputFailureNeverRepeat(t *testing.T) {
	for _, mode := range []string{"not_committed", "unknown", "confirmed cleanup", "output failure", "generic failure"} {
		t.Run(mode, func(t *testing.T) {
			f := newEntryFixture(t)
			calls := 0
			ops := sessionSendMock{t: t, submit: func(_ context.Context, _ model.Principal, _, _, _ string, c sp.Command) (sp.Operation, error) {
				calls++
				switch mode {
				case "output failure":
					r := sendReceipt(c)
					r.State = "invalid"
					return r, nil
				case "generic failure":
					return sp.Operation{}, errors.New("lost confirmation")
				default:
					outcome := store.TransactionOutcome(mode)
					if mode == "confirmed cleanup" {
						outcome = store.TransactionCommitted
					}
					return sp.Operation{}, &store.TransactionError{Outcome: outcome, Phase: "commit", CommitAttempted: true, Cause: errors.New("lost")}
				}
			}}
			if err := RegisterSessionTools(f.entry, SessionSendModule(ops)); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_send", Arguments: sendArguments()})
			if err != nil || !result.IsError || calls != 1 {
				t.Fatalf("failure result %#v %v calls=%d", result, err, calls)
			}
			failure := object(t, structured(t, result)["error"])
			want := mode
			if mode == "confirmed cleanup" || mode == "output failure" {
				want = "confirmed"
			}
			if mode == "generic failure" {
				want = "unknown"
			}
			if failure["writeOutcome"] != want || object(t, failure["refs"])["operationId"] != sendArguments()["operationId"] {
				t.Fatalf("completion facts lost: %#v", failure)
			}
		})
	}
}

func TestSessionSendCancellationAndOAuthPrincipalAreForwarded(t *testing.T) {
	actor := RequestActor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}}
	args := sendArguments()
	raw, _ := json.Marshal(args)
	var in sessionSendInput
	_ = json.Unmarshal(raw, &in)
	entered, finished := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	ops := sessionSendMock{t: t, submit: func(ctx context.Context, p model.Principal, _, _, _ string, c sp.Command) (sp.Operation, error) {
		calls.Add(1)
		if !reflect.DeepEqual(p, actor.Principal) {
			t.Error("OAuth principal changed")
		}
		close(entered)
		<-ctx.Done()
		close(finished)
		return sp.Operation{}, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan ToolResult, 1)
	go func() { result, _ := sendTaskSession(ctx, actor, ops, in); done <- result }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Submit did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("Submit did not cancel")
	}
	result := <-done
	if calls.Load() != 1 || result.WriteOutcome != "unknown" {
		t.Fatalf("cancellation repeated send or inferred rollback: %+v calls=%d", result, calls.Load())
	}
}

func TestSessionSendHTTPDeliveryFailureInvokesSubmitOnce(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	entry := additionalEntry(t, logger)
	calls := 0
	ops := sessionSendMock{t: t, submit: func(_ context.Context, _ model.Principal, _, _, _ string, c sp.Command) (sp.Operation, error) {
		calls++
		return sendReceipt(c), nil
	}}
	if err := RegisterSessionTools(entry, SessionSendModule(ops)); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "task_session_send", "arguments": sendArguments()}})
	request := httptest.NewRequest(http.MethodPost, "http://example.test/mcp", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer alice")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	request.Header.Set("X-Request-ID", "delivery-session")
	writer := &failedResponseWriter{header: make(http.Header)}
	httpx.RequestLogging(logger, entry).ServeHTTP(writer, request)
	if calls != 1 || !strings.Contains(logs.String(), `"write_outcome":"confirmed"`) || !strings.Contains(logs.String(), "MCP response delivery failed") {
		t.Fatalf("delivery lost completion/repeated send: calls=%d logs=%s", calls, logs.String())
	}
}
