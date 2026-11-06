package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPBotProductionLifecycle(t *testing.T) {
	h := projectTestHandler(t, projectTestStore(t), io.Discard)
	worker := uuid.NewString()
	body := workerSnapshotReportBody()
	host := assistantHostBody()
	host["observedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	body["assistantHost"] = host
	reportSnapshotHTTP(t, h, worker, body)
	server := httptest.NewServer(h.Handler)
	t.Cleanup(server.Close)
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
	override, failed := call("bot_create", map[string]any{"name": "Second", "workerId": worker, "cwd": "/chosen", "agent": "codex", "requestId": secondID})
	if failed || obj(obj(override["data"])["resolvedConfiguration"])["cwd"] != "/chosen" || obj(obj(override["data"])["resolvedConfiguration"])["provider"] != "codex" {
		t.Fatalf("overrides: %+v", override)
	}
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
	next, failed := call("bot_list", map[string]any{"limit": 1, "cursor": cursor})
	if failed || len(obj(next["data"])["items"].([]any)) != 1 || obj(obj(next["data"])["items"].([]any)[0])["id"] == obj(items[0])["id"] {
		t.Fatalf("second page: %+v", next)
	}
	read, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(read["data"])["id"] != id {
		t.Fatalf("show: %+v", read)
	}
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	instructions := "Use Daynight CLI."
	registration := map[string]any{"botVersion": "1", "registration": reg, "configuration": config, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	base := "/api/v1/me/workers/" + worker + "/bots/" + id
	bound := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(h, "POST", base+"/register", jsonBody(t, registration)), 200)
	decodeResponse[sp.Snapshot](t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 200)
	deletionID := uuid.NewString()
	stale, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	if !failed || obj(stale["error"])["code"] != "version_conflict" {
		t.Fatalf("stale delete: %+v", stale)
	}
	deleted, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "2", "requestId": deletionID})
	if failed {
		t.Fatalf("delete: %+v", deleted)
	}
	data = obj(deleted["data"])
	deletion := obj(data["deletion"])
	if _, exists := data["name"]; exists || deletion["deletionId"] != deletionID || obj(deletion["workerCleanup"])["state"] != "pending" || obj(deletion["serverCleanup"])["state"] != "pending" {
		t.Fatalf("deletion responsibility: %+v", data)
	}
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 409, "resource_conflict")
	shown, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(shown["data"])["deletion"])["deletionId"] != deletionID {
		t.Fatalf("show deletion: %+v", shown)
	}
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: bound.Session.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	receipt := map[string]any{"deletionId": deletionID, "stop": stop, "result": map[string]any{"state": "completed", "code": nil}}
	completed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", jsonBody(t, receipt)), 200)
	if completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup: %+v", completed)
	}
	shown, failed = call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(obj(shown["data"])["deletion"])["serverCleanup"])["state"] != "completed" {
		t.Fatalf("completed show: %+v", shown)
	}
}
