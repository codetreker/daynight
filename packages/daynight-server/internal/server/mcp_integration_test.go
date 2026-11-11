package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProductionPATIsolationAndRevocation(t *testing.T) {
	database := newHTTPTestStore(t)
	files := attachmentTestFiles(t)
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	principals := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	browserPrincipal := principals[0]
	browserPrincipal.Kind = model.SessionCredential
	browserPrincipal.CredentialID = "e5555555-5555-4555-8555-555555555555"
	browserToken := httpTestToken(model.SessionCredential)
	configureMCPPrincipals(t, database, map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1], browserToken: browserPrincipal})
	production, _ := newMCPHTTPServer(t, database, files)
	origin := production.URL
	config := configuredTestConfig()
	config.Server.PublicOrigin = origin
	config.UniAuth.CallbackURL = origin + "/api/v1/auth/callback"
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	newApp := func() *sessionApplication {
		handler, err := newTestHandler(Dependencies{Store: database, Files: files}, config, logger)
		if err != nil {
			t.Fatal(err)
		}
		app := handler.(*sessionApplication)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := app.Shutdown(ctx); err != nil {
				t.Errorf("shutdown: %v", err)
			}
		})
		return app
	}
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
	mcpIsolationInline(t, database, principals[0], uploadMetadata, true)
	upload := call(productionClient, "task_attachment_put", map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "inline", "path": "upload.txt", "contentType": "text/plain", "contentBase64": "aGVsbG8="}, false)
	data := upload["data"].(map[string]any)
	if data["writeOutcome"] != "confirmed" || data["created"] != true {
		t.Fatalf("upload receipt: %#v", upload)
	}
	address, err := attachmentcore.NewAddress(project.ID, created.ID, "upload.txt")
	if err != nil {
		t.Fatal(err)
	}
	object, err := files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "hello" || object.Info.Size != 5 {
		t.Fatalf("uploaded content=%q info=%#v read=%v close=%v", content, object.Info, readErr, closeErr)
	}
	for _, name := range []string{"task_list", "task_ready"} {
		for _, view := range []string{"summary", "full"} {
			mcpIsolationTaskRead(t, database, principals[0], project, created, name, view)
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
		mcpIsolationTaskRead(t, database, principals[0], project, created, "task_graph", view)
		value := call(productionClient, "task_graph", map[string]any{"projectId": project.ID, "taskId": created.ID, "view": view}, false)
		data := value["data"].(map[string]any)
		if data["projection"] != view || len(data["tasks"].([]any)) != 1 {
			t.Fatalf("graph %s: %#v", view, value)
		}
		assertMCPUnstartedObservation(t, data["tasks"].([]any)[0].(map[string]any))
	}
	bobQueries := mcpPATClient(t, production.URL, tokens[1])
	denyCounts := newHTTPCallPlan(t, map[string]int{"denied snapshot": 1, "denied credential": 1, "denied access": 1})
	deniedSnapshot := newHTTPTestSnapshot(t)
	deniedSnapshot.Credentials = &taskHTTPCredentialReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP denied observation credential"), CredentialFn: func(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
		denyCounts.Called("denied credential")
		mcpAttachmentCheck(t, p, principals[1])
		return store.ThreadCredential{}, nil
	}}
	deniedSnapshot.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		denyCounts.Called("denied access")
		mcpAttachmentCheck(t, p, principals[1])
		mcpAttachmentCheck(t, id, project.ID)
		return model.ProjectAccess{}, model.ErrNotFound
	}}
	database.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		denyCounts.Called("denied snapshot")
		return fn(deniedSnapshot)
	}
	if value := call(bobQueries, "task_list", map[string]any{"projectId": project.ID}, true); value["error"] == nil {
		t.Fatalf("unauthorized project: %#v", value)
	}
	attachments := attachmentservice.NewAttachments(database, database, files)
	sample := model.Attachment{ProjectID: project.ID, TaskID: created.ID, Path: "sample.txt", ContentType: "text/plain", SizeBytes: 13, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	put := func(content string) {
		t.Helper()
		item := sample
		item.SizeBytes = int64(len(content))
		isNew := content == "first content"
		if !isNew {
			item.UpdatedAt = item.UpdatedAt.Add(time.Second)
		}
		mcpIsolationInline(t, database, principals[0], item, isNew)
		if _, _, err := attachments.Put(t.Context(), principals[0], project.ID, created.ID, "sample.txt", "text/plain", strings.NewReader(content)); err != nil {
			t.Fatal(err)
		}
	}
	put("first content")
	base := map[string]any{"projectId": project.ID, "taskId": created.ID, "path": "sample.txt"}
	mcpIsolationSource(t, database, principals[0], sample, 1)
	mcpTransferPlan(t, database, mcpIsolationAuthorize(t, principals[0], project.ID, created.ID, 1), mcpIsolationAuthorize(t, principals[0], project.ID, created.ID, 1))
	inspect := call(productionClient, "task_attachment_read", base, false)["data"].(map[string]any)
	if inspect["contentIncluded"] != false || inspect["sizeBytes"] != "13" || inspect["contentRef"] == nil {
		t.Fatalf("attachment inspect: %#v", inspect)
	}
	transferID := uuid.NewString()
	open := map[string]any{"projectId": project.ID, "taskId": created.ID, "path": "sample.txt", "action": "open", "transferId": transferID}
	readable := mcpIsolationDownloadOpen(t, database, principals[0], sample, transferID, time.Now().UTC())
	opened := call(productionClient, "task_attachment_read", open, false)["data"].(map[string]any)
	if opened["transferId"] != transferID || opened["state"] != "readable" || opened["totalBytes"] != "13" || opened["sha256"] == nil {
		t.Fatalf("attachment open: %#v", opened)
	}
	put("replacement")
	chunk := map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "chunk", "transferId": transferID, "offset": "0", "format": "base64"}
	touched := mcpIsolationDownloadChunk(t, database, principals[0], readable)
	downloadData := call(productionClient, "task_attachment_read", chunk, false)["data"].(map[string]any)
	if downloadData["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("first content")) || downloadData["nextOffset"] != "13" || downloadData["eof"] != true {
		t.Fatalf("attachment snapshot: %#v", downloadData)
	}
	mcpTransferPlan(t, database, mcpTransferRead(t, principals[1], 0, 0, mcpTransferRow(touched)))
	if value := call(bobQueries, "task_attachment_read", chunk, true); value["error"] == nil {
		t.Fatalf("unauthorized snapshot: %#v", value)
	}
	closeInput := map[string]any{"projectId": project.ID, "taskId": created.ID, "action": "close", "transferId": transferID}
	mcpIsolationDownloadClose(t, database, principals[0], touched)
	closed := call(productionClient, "task_attachment_read", closeInput, false)["data"].(map[string]any)
	if closed["state"] != "cleanup_pending" || closed["cleanupState"] != "pending" {
		t.Fatalf("attachment close: %#v", closed)
	}

	// A separate production router with an explicitly test-only tool exposes the
	// authenticated request actor without adding a discoverable production tool.
	instrumented := newApp()
	entry := instrumented.mcp
	input := map[string]any{"type": "object"}
	output := map[string]any{"type": "object"}
	err = entry.RegisterTool(&sdk.Tool{Name: "test_actor", InputSchema: input, OutputSchema: output}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "credential": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, instrumented))
	t.Cleanup(server.Close)
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
	assertStatus("invalid", http.StatusUnauthorized)
	configureMCPPrincipals(t, database, map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1], browserToken: browserPrincipal})
	mcpIsolationRevocation(t, database, browserPrincipal, principals[0].CredentialID)
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
	mcpIsolationRevokedAuthentication(t, database, tokens[0], tokens[1], principals[1])
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
