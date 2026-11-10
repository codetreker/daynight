package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPBotProductionLifecycle(t *testing.T) {
	principal := defaultHTTPPrincipal()
	worker := uuid.NewString()
	now := time.Now().UTC()
	modelName := "gpt-5"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: &modelName, Args: []string{"--effort", "high"}}
	ops := &mcpBotOperations{t: t, principal: principal}
	server, _ := newMCPOperationServer(t, map[string]model.Principal{defaultHTTPToken(): principal}, attachmentTestFiles(t), func(app *service.App) { app.Bots, app.BotDeletions = ops, ops })
	h := newOperationHTTPServer(t, func(deps *httpDependencies) {
		deps.Bots, deps.BotDeletions, deps.BotRuntime = ops, ops, ops
		deps.Relay = sessionhttp.NewRoutesWithOperations(sessionhttp.Operations{TestSnapshot: ops.TestSnapshot}, deps.Auth.RequestAuthentication, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}, io.Discard, principal)
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
	ops.expectCreate(botcore.CreateBot{ID: id, Name: "Assistant", Overrides: model.BotOverrides{}}, expected)
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
	ops.expectCreate(botcore.CreateBot{ID: secondID, Name: "Second", Overrides: model.BotOverrides{WorkerID: &worker, Cwd: &chosen, Provider: &provider}}, second)
	override, failed := call("bot_create", map[string]any{"name": "Second", "workerId": worker, "cwd": "/chosen", "agent": "codex", "requestId": secondID})
	if failed || obj(obj(override["data"])["resolvedConfiguration"])["cwd"] != "/chosen" || obj(obj(override["data"])["resolvedConfiguration"])["provider"] != "codex" {
		t.Fatalf("overrides: %+v", override)
	}
	cursorBytes, _ := json.Marshal(struct {
		Version            int                 `json:"version"`
		Kind               string              `json:"kind"`
		ProjectID          string              `json:"projectId"`
		Status             *string             `json:"status"`
		Ready              *bool               `json:"ready"`
		AllowAgents        *bool               `json:"allowAgents"`
		CompatiblePlatform *model.TaskPlatform `json:"compatiblePlatform"`
		WorkerID           *string             `json:"workerId"`
		WorkerUserID       *string             `json:"workerUserId"`
		CreatedAt          time.Time           `json:"createdAt"`
		ID                 string              `json:"id"`
	}{Version: 1, Kind: "bots", WorkerUserID: &principal.UserID, CreatedAt: expected.CreatedAt, ID: expected.ID})
	nextCursor := base64.RawURLEncoding.EncodeToString(cursorBytes)
	ops.expectList(model.PageRequest{Limit: 1}, botcore.BotPage{Items: []model.Bot{expected}, NextCursor: &nextCursor})
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
	ops.expectList(model.PageRequest{Limit: 1, Cursor: &nextCursor}, botcore.BotPage{Items: []model.Bot{second}})
	next, failed := call("bot_list", map[string]any{"limit": 1, "cursor": cursor})
	if failed || len(obj(next["data"])["items"].([]any)) != 1 || obj(obj(next["data"])["items"].([]any)[0])["id"] == obj(items[0])["id"] {
		t.Fatalf("second page: %+v", next)
	}
	ops.expectGet(id, expected)
	read, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(read["data"])["id"] != id {
		t.Fatalf("show: %+v", read)
	}
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	instructions := "Use Daynight CLI."
	registration := map[string]any{"botVersion": "1", "registration": reg, "configuration": config, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	base := "/api/v1/me/workers/" + worker + "/bots/" + id
	sessionID, historyEpoch := uuid.NewString(), uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: reg.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: principal.UserID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, AgentControlMode: "web", Provider: "copilot"}, SessionRevision: "1", HistoryEpoch: historyEpoch, LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	role := model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
	boundModel := botExpiryCloneBot(expected)
	boundModel.Version, boundModel.SessionID, boundModel.TestExecutionID, boundModel.RoleConfiguration, boundModel.UpdatedAt = 2, &sessionID, &reg.TestExecutionID, &role, now.Add(time.Second)
	registrationInput := sessioncore.BotRegistration{BotVersion: 1, Registration: reg, Configuration: configuration, RoleConfiguration: role}
	registrationInput.Configuration.Args = botExpiryCloneSlice(configuration.Args)
	registerCall := ops.once("RegisterBot")
	ops.register = func(ctx context.Context, p model.Principal, gotWorker, gotID string, in sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error) {
		registerCall()
		ops.check(ctx, p, "RegisterBot")
		if gotWorker != worker || gotID != id || !reflect.DeepEqual(in, registrationInput) {
			t.Errorf("Bot registration changed: %s/%s/%#v", gotWorker, gotID, in)
		}
		return sessioncore.BotRegistrationResult{Bot: botExpiryCloneBot(boundModel), Session: botExpiryCloneSnapshot(snapshot)}, nil
	}
	bound := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(h, "POST", base+"/register", jsonBody(t, registration)), 200)
	if !reflect.DeepEqual(bound.Session, snapshot) {
		t.Fatalf("registration snapshot=%#v, want %#v", bound.Session, snapshot)
	}
	readCall := ops.once("TestSnapshot")
	ops.snapshot = func(ctx context.Context, p model.Principal, got string) (sp.Snapshot, error) {
		readCall()
		ops.check(ctx, p, "TestSnapshot")
		if got != sessionID {
			t.Errorf("snapshot id=%s", got)
		}
		return botExpiryCloneSnapshot(snapshot), nil
	}
	decodeResponse[sp.Snapshot](t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 200)
	deletionID := uuid.NewString()
	ops.expectDelete(id, store.DeleteBot{Version: 1, DeletionID: deletionID}, model.Bot{}, &model.Fault{Code: "version_conflict", Message: "Bot version changed."})
	stale, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	if !failed || obj(stale["error"])["code"] != "version_conflict" {
		t.Fatalf("stale delete: %+v", stale)
	}
	deletionModel := boundModel
	deletionModel.Version = 3
	deletionModel.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deletionModel.UpdatedAt = now.Add(2 * time.Second)
	ops.expectDelete(id, store.DeleteBot{Version: 2, DeletionID: deletionID}, deletionModel, nil)
	deleted, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "2", "requestId": deletionID})
	if failed {
		t.Fatalf("delete: %+v", deleted)
	}
	data = obj(deleted["data"])
	deletion := obj(data["deletion"])
	if _, exists := data["name"]; exists || deletion["deletionId"] != deletionID || obj(deletion["workerCleanup"])["state"] != "pending" || obj(deletion["serverCleanup"])["state"] != "pending" {
		t.Fatalf("deletion responsibility: %+v", data)
	}
	deletedRead := ops.once("TestSnapshot deleted")
	ops.snapshot = func(ctx context.Context, p model.Principal, got string) (sp.Snapshot, error) {
		deletedRead()
		ops.check(ctx, p, "TestSnapshot")
		if got != sessionID {
			t.Errorf("deleted snapshot id=%s", got)
		}
		return sp.Snapshot{}, &model.Fault{Code: "resource_conflict", Message: "Bot was deleted."}
	}
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 409, "resource_conflict")
	ops.expectGet(id, deletionModel)
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
	completionCall := ops.once("CompleteBotDeletion")
	expectedReceipt := botservice.BotDeletionReceipt{DeletionID: deletionID, Stop: botExpiryClonePointer(&stop), Result: model.BotCleanupResult{State: "completed"}}
	ops.complete = func(ctx context.Context, p model.Principal, gotWorker, gotID string, in botservice.BotDeletionReceipt) (model.Bot, error) {
		completionCall()
		ops.check(ctx, p, "CompleteBotDeletion")
		if gotWorker != worker || gotID != id || !reflect.DeepEqual(in, expectedReceipt) {
			t.Errorf("deletion receipt changed: %s/%s/%#v", gotWorker, gotID, in)
		}
		return botExpiryCloneBot(final), nil
	}
	completed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", jsonBody(t, receipt)), 200)
	if completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup: %+v", completed)
	}
	ops.expectGet(id, final)
	shown, failed = call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(obj(shown["data"])["deletion"])["serverCleanup"])["state"] != "completed" {
		t.Fatalf("completed show: %+v", shown)
	}
}
