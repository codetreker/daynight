package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	uploadservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProductionPATIsolationAndRevocation(t *testing.T) {
	files := attachmentTestFiles(t)
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	principals := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	browserPrincipal := principals[0]
	browserPrincipal.Kind = model.SessionCredential
	browserPrincipal.CredentialID = "e5555555-5555-4555-8555-555555555555"
	browserToken := httpTestToken(model.SessionCredential)
	declared := map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1], browserToken: browserPrincipal}
	org := newMCPOrgFixture(t)
	tasks := &mcpIsolationTasks{operationRejectedTasks: operationRejectedTasks{t: t}}
	observations := &mcpIsolationObservations{operationRejectedTaskObservations: operationRejectedTaskObservations{t: t}}
	uploads := &mcpUploadOperations{t: t}
	downloads := &mcpIsolationDownloads{operationRejectedDownloads: operationRejectedDownloads{t: t}}
	var identity *mcpOperationIdentity
	production, _ := newMCPOperationServer(t, declared, files, func(app *service.App) {
		org.configure(app)
		app.Tasks, app.TaskObservations, app.Uploads, app.Downloads = tasks, observations, uploads, downloads
		identity = app.Identity.(*mcpOperationIdentity)
	})
	origin := production.URL
	config := configuredTestConfig()
	config.PublicOrigin = origin
	config.UniAuthCallbackURL = origin + "/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	if principals[0].UserID == principals[1].UserID || principals[0].CredentialID == principals[1].CredentialID {
		t.Fatal("fixture PATs do not identify distinct accounts and credentials")
	}
	productionClient := mcpPATClient(t, production.URL, tokens[0])
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	list, err := productionClient.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("production tools: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
	project := projectHTTPRecord("f6666666-6666-4666-8666-666666666666", "MCP queries", "host:mcp-queries", "a7777777-7777-4777-8777-777777777777")
	created := model.Task{ID: "b8888888-8888-4888-8888-888888888888", ProjectID: project.ID, Title: "Ready task", Description: "Complete description", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, Ready: true, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}}
	call := func(session *sdk.ClientSession, name string, args map[string]any, wantError bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError != wantError {
			t.Fatalf("%s: %#v, %v", name, result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	uploadMetadata := model.Attachment{ProjectID: project.ID, TaskID: created.ID, Path: "upload.txt", ContentType: "text/plain", SizeBytes: 5, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	uploadActor := transfercore.Actor{Principal: principals[0], AuthorityKind: "pat", AuthorityID: principals[0].CredentialID}
	uploads.expect(uploadActor, project.ID, created.ID, uploadservice.UploadInput{Action: "inline", Path: "upload.txt", ContentType: "text/plain", ContentBase64: "aGVsbG8="}, map[string]any{"attachment": mcpIsolationAttachment(uploadMetadata), "created": true, "writeOutcome": "confirmed"}, nil, 1)
	upload := call(productionClient, "task_attachment_put", map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "inline", "path": "upload.txt", "contentType": "text/plain", "contentBase64": "aGVsbG8="}, false)
	data := upload["data"].(map[string]any)
	if data["writeOutcome"] != "confirmed" || data["created"] != true {
		t.Fatalf("upload receipt: %#v", upload)
	}
	for _, name := range []string{"task_list", "task_ready"} {
		for _, view := range []string{"summary", "full"} {
			mcpIsolationTaskRead(t, tasks, observations, principals[0], project, created, name, view)
			value := call(productionClient, name, map[string]any{"projectId": project.ID, "view": view}, false)
			data := value["data"].(map[string]any)
			items := data["items"].([]any)
			if data["projection"] != view || len(items) != 1 || items[0].(map[string]any)["id"] != created.ID || items[0].(map[string]any)["version"] != "1" {
				t.Fatalf("%s %s: %#v", name, view, value)
			}
			if name == "task_ready" && view == "full" && items[0].(map[string]any)["description"] != "Complete description" {
				t.Fatalf("ready full: %#v", value)
			}
			if name == "task_list" {
				assertMCPUnstartedObservation(t, items[0].(map[string]any))
			}
		}
	}
	for _, view := range []string{"summary", "full"} {
		mcpIsolationTaskRead(t, tasks, observations, principals[0], project, created, "task_graph", view)
		value := call(productionClient, "task_graph", map[string]any{"projectId": project.ID, "taskId": created.ID, "view": view}, false)
		data := value["data"].(map[string]any)
		if data["projection"] != view || len(data["tasks"].([]any)) != 1 {
			t.Fatalf("graph %s: %#v", view, value)
		}
		assertMCPUnstartedObservation(t, data["tasks"].([]any)[0].(map[string]any))
	}
	bobQueries := mcpPATClient(t, production.URL, tokens[1])
	deniedCall := projectHTTPCount(t, 1)
	observations.list = func(ctx context.Context, p model.Principal, pid string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
		deniedCall()
		mcpAttachmentCheck(t, p, principals[1])
		mcpAttachmentCheck(t, pid, project.ID)
		mcpAttachmentCheck(t, request, taskcore.MCPListRequest{Limit: 50, View: "summary"})
		return taskservice.ObservedMCPPage{}, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound}
	}
	if value := call(bobQueries, "task_list", map[string]any{"projectId": project.ID}, true); value["error"] == nil {
		t.Fatalf("unauthorized project: %#v", value)
	}
	sample := model.Attachment{ProjectID: project.ID, TaskID: created.ID, Path: "sample.txt", ContentType: "text/plain", SizeBytes: 13, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	base := map[string]any{"projectId": project.ID, "taskId": created.ID, "path": "sample.txt"}
	downloads.expect(uploadActor, mcpdownload.Input{ProjectID: project.ID, TaskID: created.ID, Path: "sample.txt"}, map[string]any{"attachment": mcpIsolationAttachment(sample), "sizeBytes": "13", "contentRef": map[string]any{"projectId": project.ID, "taskId": created.ID, "path": "sample.txt"}, "contentIncluded": false}, nil)
	inspect := call(productionClient, "task_attachment_read", base, false)["data"].(map[string]any)
	if inspect["contentIncluded"] != false || inspect["sizeBytes"] != "13" || inspect["contentRef"] == nil {
		t.Fatalf("attachment inspect: %#v", inspect)
	}
	transferID := uuid.NewString()
	open := map[string]any{"projectId": project.ID, "taskId": created.ID, "path": "sample.txt", "action": "open", "transferId": transferID}
	expires := time.Now().UTC().Add(time.Hour)
	digest := sha256.Sum256([]byte("first content"))
	downloads.expect(uploadActor, mcpdownload.Input{ProjectID: project.ID, TaskID: created.ID, Path: "sample.txt", Action: "open", TransferID: transferID}, map[string]any{"transferId": transferID, "direction": "download", "state": "readable", "maxChunkBytes": 524288, "expiresAt": expires, "contentRef": map[string]any{"projectId": project.ID, "taskId": created.ID, "transferId": transferID}, "attachment": mcpIsolationAttachment(sample), "totalBytes": "13", "sha256": hex.EncodeToString(digest[:]), "nextOffset": "0"}, nil)
	opened := call(productionClient, "task_attachment_read", open, false)["data"].(map[string]any)
	if opened["transferId"] != transferID || opened["state"] != "readable" || opened["totalBytes"] != "13" || opened["sha256"] == nil {
		t.Fatalf("attachment open: %#v", opened)
	}
	chunk := map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "chunk", "transferId": transferID, "offset": "0", "format": "base64"}
	downloads.expect(uploadActor, mcpdownload.Input{ProjectID: project.ID, TaskID: created.ID, Action: "chunk", TransferID: transferID, Offset: "0", Format: "base64"}, map[string]any{"transferId": transferID, "state": "readable", "offset": "0", "totalBytes": "13", "expiresAt": expires, "encoding": "base64", "contentBase64": base64.StdEncoding.EncodeToString([]byte("first content")), "sha256": hex.EncodeToString(digest[:]), "readBytes": "13", "nextOffset": "13", "eof": true}, nil)
	downloadData := call(productionClient, "task_attachment_read", chunk, false)["data"].(map[string]any)
	if downloadData["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("first content")) || downloadData["nextOffset"] != "13" || downloadData["eof"] != true {
		t.Fatalf("attachment snapshot: %#v", downloadData)
	}
	downloads.expect(transfercore.Actor{Principal: principals[1], AuthorityKind: "pat", AuthorityID: principals[1].CredentialID}, mcpdownload.Input{ProjectID: project.ID, TaskID: created.ID, Action: "chunk", TransferID: transferID, Offset: "0", Format: "base64"}, nil, &model.Fault{Code: "transfer_conflict", Message: "Transfer binding does not match."})
	if value := call(bobQueries, "task_attachment_read", chunk, true); value["error"] == nil {
		t.Fatalf("unauthorized snapshot: %#v", value)
	}
	closeInput := map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "close", "transferId": transferID}
	downloads.expect(uploadActor, mcpdownload.Input{ProjectID: project.ID, TaskID: created.ID, Action: "close", TransferID: transferID}, map[string]any{"transferId": transferID, "state": "cleanup_pending", "cleanupState": "pending"}, nil)
	closed := call(productionClient, "task_attachment_read", closeInput, false)["data"].(map[string]any)
	if closed["state"] != "cleanup_pending" || closed["cleanupState"] != "pending" {
		t.Fatalf("attachment close: %#v", closed)
	}

	exerciseMCPTeams(t, org, productionClient, mcpPATClient(t, production.URL, tokens[1]), principals)

	// A separate production router with an explicitly test-only tool exposes the
	// authenticated request actor without adding a discoverable production tool.
	server, instrumented := newMCPOperationServerWithConfig(t, declared, files, config, func(app *service.App) {})
	entry := instrumented.mcp
	input := map[string]any{"type": "object"}
	output := map[string]any{"type": "object"}
	err = entry.RegisterTool(&sdk.Tool{Name: "test_actor", InputSchema: input, OutputSchema: output}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "credential": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sessions := []*sdk.ClientSession{mcpPATClient(t, server.URL, tokens[0]), mcpPATClient(t, server.URL, tokens[1])}
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for i := range sessions {
		wg.Go(func() {
			for range 12 {
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				result, err := sessions[i].CallTool(ctx, &sdk.CallToolParams{Name: "test_actor", Arguments: map[string]any{}})
				cancel()
				if err != nil || result.IsError {
					failures <- fmt.Errorf("tool call %d: %v", i, err)
					return
				}
				encoded, err := json.Marshal(result.StructuredContent)
				if err != nil {
					failures <- err
					return
				}
				var envelope struct {
					Data struct{ User, Credential, Kind string }
				}
				if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Data.User != principals[i].UserID || envelope.Data.Credential != principals[i].CredentialID || envelope.Data.Kind != "pat" {
					failures <- fmt.Errorf("unexpected actor for client %d: %s (%v)", i, encoded, err)
					return
				}
			}
		})
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}

	assertStatus := func(token string, expected int) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, production.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2026-07-28")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != expected {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			t.Errorf("MCP status: got %d, want %d: %s", resp.StatusCode, expected, body)
		}
	}
	identity.setCredential(model.PATCredential, "invalid", model.Principal{}, model.Unauthenticated(nil))
	assertStatus("invalid", http.StatusUnauthorized)
	revokeCall := projectHTTPCount(t, 1)
	identity.RevokePATCall = func(ctx context.Context, p model.Principal, id string) error {
		revokeCall()
		mcpAttachmentCheck(t, p, browserPrincipal)
		mcpAttachmentCheck(t, id, principals[0].CredentialID)
		return nil
	}
	revoke, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, origin+"/api/v1/me/tokens/"+principals[0].CredentialID, nil)
	if err != nil {
		t.Fatal(err)
	}
	revoke.Header.Set("Origin", origin)
	revoke.AddCookie(&http.Cookie{Name: "daynight_session", Value: browserToken})
	resp, err := http.DefaultClient.Do(revoke)
	if err != nil {
		t.Fatal(err)
	}
	if err = resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: HTTP %d", resp.StatusCode)
	}
	identity.setCredential(model.PATCredential, tokens[0], model.Principal{}, model.Unauthenticated(model.ErrNotFound))
	assertStatus(tokens[0], http.StatusUnauthorized)
	bobProduction := mcpPATClient(t, production.URL, tokens[1])
	ctx, cancel = context.WithTimeout(t.Context(), 5*time.Second)
	list, err = bobProduction.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("remaining PAT discovery: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
}
