package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// lostBotReceiptTransport consumes the completed response before reporting a
// delivery failure, while counting each operation sent to the server.
type lostBotReceiptTransport struct {
	token       string
	createCalls atomic.Int32
	deleteCalls atomic.Int32
	completed   atomic.Int32
}

func (tr *lostBotReceiptTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+tr.token)
	var input struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if req.Body != nil {
		body, err := io.ReadAll(io.LimitReader(req.Body, 4<<20+1))
		if err != nil {
			return nil, err
		}
		if len(body) > 4<<20 {
			return nil, errors.New("test request exceeds bound")
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = json.Unmarshal(body, &input)
	}
	switch {
	case input.Method != "tools/call":
		return http.DefaultTransport.RoundTrip(r)
	case input.Params.Name == "bot_create":
		tr.createCalls.Add(1)
	case input.Params.Name == "bot_delete":
		tr.deleteCalls.Add(1)
	default:
		return http.DefaultTransport.RoundTrip(r)
	}
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(body) > 1<<20 || resp.StatusCode != http.StatusOK {
		return nil, errors.New("unexpected server response")
	}
	var doc struct {
		Result *struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			} `json:"structuredContent"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || len(doc.Error) != 0 || doc.Result == nil || doc.Result.IsError || doc.Result.StructuredContent.Data.ID == "" {
		return nil, errors.New("server did not confirm operation")
	}
	tr.completed.Add(1)
	return nil, errors.New("Bot receipt lost after response")
}

func TestMCPBotLostReceiptsRemainReconciliable(t *testing.T) {
	tx := newHTTPTestStore(t)
	principal := defaultHTTPPrincipal()
	worker := uuid.NewString()
	now := time.Now().UTC()
	defaults := mcpBotDefaults(principal.UserID, worker, now)
	modelName := "gpt-5"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: &modelName, Args: []string{"--effort", "high"}}
	server, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
	h := &resourceTestHandler{Handler: server.Config.Handler, token: defaultHTTPToken(), principal: principal}

	tr := &lostBotReceiptTransport{token: h.token}
	client := sdk.NewClient(&sdk.Implementation{Name: "lost-bot-receipt", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	lost, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: tr}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lost.Close() })
	reader := mcpPATClient(t, server.URL, h.token)
	callLost := func(name string, args map[string]any) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		if _, err := lost.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args}); err == nil {
			t.Fatalf("%s unexpectedly received a receipt", name)
		}
	}
	show := func(id string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := reader.CallTool(ctx, &sdk.CallToolParams{Name: "bot_show", Arguments: map[string]any{"botId": id}})
		if err != nil || result.IsError {
			t.Fatalf("show: %+v %v", result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(encoded, &doc); err != nil {
			t.Fatal(err)
		}
		return doc.Data
	}
	id, deletionID := uuid.NewString(), uuid.NewString()
	expected := mcpBotModel(principal.UserID, worker, id, "Lost receipt", model.BotOverrides{}, configuration, now)
	mcpBotCreation(t, tx, principal, defaults, expected)
	callLost("bot_create", map[string]any{"name": "Lost receipt", "requestId": id})
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, expected, nil))
	created := show(id)
	if tr.createCalls.Load() != 1 || tr.completed.Load() != 1 || created["id"] != id || created["version"] != "1" || created["workerId"] != worker {
		t.Fatalf("create calls=%d completed=%d data=%+v", tr.createCalls.Load(), tr.completed.Load(), created)
	}
	deletionModel := expected
	deletionModel.Version = 2
	deletionModel.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 1, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deletionModel.UpdatedAt = now.Add(time.Second)
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, expected, nil), mcpBotCall("LockBotSessions", []any{id}, []store.BotSession{}, nil), mcpBotCall("RevokeBotSessions", []any{id}, nil), mcpBotCall("SaveBotDeletion", []any{id, deletionModel.Deletion}, deletionModel, nil), mcpBotLockCredentialCall(t, principal))
	callLost("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, deletionModel, nil))
	deleted := show(id)
	deletion, ok := deleted["deletion"].(map[string]any)
	if tr.createCalls.Load() != 1 || tr.deleteCalls.Load() != 1 || tr.completed.Load() != 2 || deleted["id"] != id || deleted["version"] != "2" || !ok || deletion["deletionId"] != deletionID || deletion["requestedVersion"] != "1" {
		t.Fatalf("delete createCalls=%d deleteCalls=%d completed=%d data=%+v", tr.createCalls.Load(), tr.deleteCalls.Load(), tr.completed.Load(), deleted)
	}
}
