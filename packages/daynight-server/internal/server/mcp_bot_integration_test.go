package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPBotProductionLifecycle(t *testing.T) {
	tx := newHTTPTestStore(t)
	principal := defaultHTTPPrincipal()
	worker := uuid.NewString()
	now := time.Now().UTC()
	defaults := mcpBotDefaults(principal.UserID, worker, now)
	modelName := "gpt-5"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: &modelName, Args: []string{"--effort", "high"}}
	server, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
	h := &resourceTestHandler{Handler: server.Config.Handler, token: defaultHTTPToken(), principal: principal}
	client := mcpPATClient(t, server.URL, h.token)
	call := func(name string, args map[string]any) (map[string]any, bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err = json.Unmarshal(b, &doc); err != nil {
			t.Fatal(err)
		}
		return doc, result.IsError
	}
	obj := func(v any) map[string]any {
		t.Helper()
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("expected object: %#v", v)
		}
		return m
	}
	id := uuid.NewString()
	expected := mcpBotModel(principal.UserID, worker, id, "Assistant", model.BotOverrides{}, configuration, now)
	mcpBotCreation(t, tx, principal, defaults, expected)
	created, failed := call("bot_create", map[string]any{"name": "Assistant", "requestId": id})
	if failed {
		t.Fatalf("create: %+v", created)
	}
	data := obj(created["data"])
	config := obj(data["resolvedConfiguration"])
	if data["id"] != id || data["version"] != "1" || data["workerId"] != worker || config["cwd"] != "/workspace" || config["provider"] != "copilot" || obj(data["startupResult"])["state"] != "pending" || len(obj(data["requestedOverrides"])) != 0 {
		t.Fatalf("default create: %+v", data)
	}
	secondID := uuid.NewString()
	chosen, provider := "/chosen", "codex"
	second := mcpBotModel(principal.UserID, worker, secondID, "Second", model.BotOverrides{WorkerID: &worker, Cwd: &chosen, Provider: &provider}, model.BotConfiguration{WorkerID: worker, Cwd: chosen, Provider: provider, Args: []string{}}, now.Add(time.Second))
	mcpBotCreation(t, tx, principal, defaults, second)
	override, failed := call("bot_create", map[string]any{"name": "Second", "workerId": worker, "cwd": "/chosen", "agent": "codex", "requestId": secondID})
	if failed || obj(obj(override["data"])["resolvedConfiguration"])["cwd"] != "/chosen" || obj(obj(override["data"])["resolvedConfiguration"])["provider"] != "codex" {
		t.Fatalf("overrides: %+v", override)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bots", []any{principal.UserID, (*string)(nil), store.Page{Limit: 1}}, store.BotPage{Items: []model.Bot{expected}, HasMore: true}, nil))
	page, failed := call("bot_list", map[string]any{"limit": 1})
	if failed {
		t.Fatalf("list: %+v", page)
	}
	first := obj(page["data"])
	items := first["items"].([]any)
	cursor, ok := first["nextCursor"].(string)
	if len(items) != 1 || !ok {
		t.Fatalf("first page: %+v", first)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bots", []any{principal.UserID, (*string)(nil), store.Page{Limit: 1, After: &store.Position{CreatedAt: expected.CreatedAt, ID: expected.ID}}}, store.BotPage{Items: []model.Bot{second}}, nil))
	next, failed := call("bot_list", map[string]any{"limit": 1, "cursor": cursor})
	if failed || len(obj(next["data"])["items"].([]any)) != 1 || obj(obj(next["data"])["items"].([]any)[0])["id"] == obj(items[0])["id"] {
		t.Fatalf("second page: %+v", next)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, expected, nil))
	read, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(read["data"])["id"] != id {
		t.Fatalf("show: %+v", read)
	}
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	instructions := "Use Daynight CLI."
	registration := map[string]any{"botVersion": "1", "registration": reg, "configuration": config, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	base := "/api/v1/me/workers/" + worker + "/bots/" + id
	var inserted store.SessionRegistration
	bindingResult := []any{model.Bot{}, nil}
	bindCall := mcpBotExpectedCall{name: "BindBotSession", result: bindingResult, check: func(args []any) {
		if len(args) != 4 || args[0] != id || args[1] != int64(1) || args[2] != inserted.Location.SessionID || args[3] != (model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}) {
			unexpectedHTTPCall(t, "Bot binding fields")
		}
		value := expected
		value.Version = 2
		value.SessionID = &inserted.Location.SessionID
		value.TestExecutionID = &reg.TestExecutionID
		value.RoleConfiguration = &model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
		value.UpdatedAt = now.Add(time.Second)
		bindingResult[0] = value
	}}
	insertCall := mcpBotExpectedCall{name: "InsertBotSession", result: []any{true, nil}, check: func(args []any) {
		value := args[0].(store.SessionRegistration)
		if value.OwnerID != principal.UserID || value.ParentCredentialID != principal.CredentialID || value.BotID == nil || *value.BotID != id || value.RegistrationID != reg.RegistrationID || value.TestExecutionID != reg.TestExecutionID || value.Location.SessionID == "" || value.Snapshot.TestExecutionID != reg.TestExecutionID || value.Snapshot.Identity.OwnerUserID != principal.UserID || value.Snapshot.Identity.Provider != "copilot" || value.Snapshot.ConnectionEpoch != "0" || value.Snapshot.ExecutionGeneration != "1" || value.Snapshot.InitialInputState != "not_required" {
			unexpectedHTTPCall(t, "Bot Session registration fields")
		}
		var input map[string]any
		if err := json.Unmarshal(value.Registration, &input); err != nil || input["botVersion"] != "1" {
			unexpectedHTTPCall(t, "Bot Session frozen registration")
		}
		inserted = value
	}}
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, expected, nil), insertCall, bindCall, mcpBotLockCredentialCall(t, principal))
	bound := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(h, "POST", base+"/register", jsonBody(t, registration)), 200)
	boundModel := expected
	boundModel.Version = 2
	boundModel.SessionID = &bound.Session.SessionID
	boundModel.TestExecutionID = &reg.TestExecutionID
	boundModel.RoleConfiguration = &model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
	boundModel.UpdatedAt = now.Add(time.Second)
	record := store.SessionRecord{BotID: &id, Snapshot: bound.Session, Owner: principal.UserID, Parent: principal.CredentialID, Registration: inserted.Registration}
	mcpBotSession(t, tx, mcpBotCall("SessionBotID", []any{bound.Session.SessionID}, &id, nil), mcpBotCall("Bot", []any{id}, boundModel, nil), mcpBotCall("LockSession", []any{bound.Session.SessionID}, record, nil), mcpBotLockCredentialCall(t, principal), mcpBotLockCredentialCall(t, principal))
	decodeResponse[sp.Snapshot](t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 200)
	deletionID := uuid.NewString()
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, boundModel, nil))
	stale, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	if !failed || obj(stale["error"])["code"] != "version_conflict" {
		t.Fatalf("stale delete: %+v", stale)
	}
	deletionModel := boundModel
	deletionModel.Version = 3
	deletionModel.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deletionModel.UpdatedAt = now.Add(2 * time.Second)
	botSessions := []store.BotSession{{ID: bound.Session.SessionID, Owner: principal.UserID, Scope: "test", Backend: "web"}}
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, boundModel, nil), mcpBotCall("LockBotSessions", []any{id}, botSessions, nil), mcpBotCall("RevokeBotSessions", []any{id}, nil), mcpBotCall("SaveBotDeletion", []any{id, deletionModel.Deletion}, deletionModel, nil), mcpBotLockCredentialCall(t, principal))
	deleted, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "2", "requestId": deletionID})
	if failed {
		t.Fatalf("delete: %+v", deleted)
	}
	data = obj(deleted["data"])
	deletion := obj(data["deletion"])
	if _, exists := data["name"]; exists || deletion["deletionId"] != deletionID || obj(deletion["workerCleanup"])["state"] != "pending" || obj(deletion["serverCleanup"])["state"] != "pending" {
		t.Fatalf("deletion responsibility: %+v", data)
	}
	mcpBotSession(t, tx, mcpBotCall("SessionBotID", []any{bound.Session.SessionID}, &id, nil), mcpBotCall("Bot", []any{id}, deletionModel, nil))
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 409, "resource_conflict")
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, deletionModel, nil))
	shown, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(shown["data"])["deletion"])["deletionId"] != deletionID {
		t.Fatalf("show deletion: %+v", shown)
	}
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: bound.Session.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	receipt := map[string]any{"deletionId": deletionID, "stop": stop, "result": map[string]any{"state": "completed", "code": nil}}
	workerComplete := deletionModel
	workerComplete.Version = 4
	workerComplete.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	rawReceipt, _ := json.Marshal(struct {
		DeletionID string                 `json:"deletionId"`
		Stop       *sp.TestStop           `json:"stop"`
		Result     model.BotCleanupResult `json:"result"`
	}{DeletionID: deletionID, Stop: &stop, Result: model.BotCleanupResult{State: "completed"}})
	receiptHash := sha256.Sum256(rawReceipt)
	workerComplete.Deletion.ReceiptDigest = fmt.Sprintf("%x", receiptHash)
	final := workerComplete
	final.Version = 5
	final.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "completed"}, ReceiptDigest: workerComplete.Deletion.ReceiptDigest}
	receiptScript := mcpBotScript(t, mcpBotCall("WriteSession", nil), mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, deletionModel, nil), mcpBotCall("LockBotSessionStop", []any{bound.Session.SessionID, id, principal.UserID}, store.BotSessionStop{Snapshot: bound.Session}, nil), mcpBotCall("SaveBotDeletion", []any{id, workerComplete.Deletion}, workerComplete, nil), mcpBotCall("WriteSession", nil), mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, workerComplete, nil), mcpBotCall("LockBotSessions", []any{id}, botSessions, nil), mcpBotCall("DeleteBotSession", []any{bound.Session.SessionID, id}, nil), mcpBotCall("RedactDeletedBot", []any{id}, nil), mcpBotCall("SaveBotDeletion", []any{id, final.Deletion}, final, nil))
	tx.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		receiptScript.call("WriteSession")
		err := fn(mcpBotSessionScope{session: &mcpBotSessionDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, s: receiptScript}, bot: &mcpBotWriteDAO{s: receiptScript}})
		return mcpBotResult(err)
	}
	completed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", jsonBody(t, receipt)), 200)
	if completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup: %+v", completed)
	}
	receiptScript.verify()
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, final, nil))
	shown, failed = call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(obj(shown["data"])["deletion"])["serverCleanup"])["state"] != "completed" {
		t.Fatalf("completed show: %+v", shown)
	}
}
