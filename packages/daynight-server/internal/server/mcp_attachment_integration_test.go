package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPAttachmentProductionLifecycle(t *testing.T) {
	principal := defaultHTTPPrincipal()
	bobPrincipal := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	tokens := []string{defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"}
	files := attachmentTestFiles(t)
	ops := &mcpAttachmentOperations{t: t}
	production, _ := newMCPOperationServer(t, map[string]model.Principal{tokens[0]: principal, tokens[1]: bobPrincipal}, files, func(app *service.App) { app.Attachments = ops })
	origin := production.URL
	alice, bob := mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])
	projectID := "e5555555-5555-4555-8555-555555555555"
	parentID := "f6666666-6666-4666-8666-666666666666"
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	item := func(path, contentType string, size int64) model.Attachment {
		return model.Attachment{ProjectID: projectID, TaskID: parentID, Path: path, ContentType: contentType, SizeBytes: size, CreatedAt: at, UpdatedAt: at}
	}
	call := func(client *sdk.ClientSession, name string, args map[string]any, failure bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError != failure {
			t.Fatalf("%s: result=%+v error=%v", name, result, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	obj := func(value any) map[string]any {
		t.Helper()
		out, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("not an object: %#v", value)
		}
		return out
	}

	args := map[string]any{"projectId": projectID, "taskId": parentID, "limit": 2}
	ops.expectList(bobPrincipal, projectID, parentID, model.PageRequest{Limit: 2}, attachmentcore.Page{}, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	denied := call(bob, "task_attachment_list", args, true)
	if obj(denied["error"])["code"] != "not_found" {
		t.Fatalf("denied: %+v", denied)
	}
	a, b, c := item("a", "text/plain", 6), item("b", "text/plain", 6), item("c", "text/plain", 6)
	cursor := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"version":1,"kind":"attachments","projectId":%q,"taskId":%q,"path":"b"}`, projectID, parentID)))
	ops.expectList(principal, projectID, parentID, model.PageRequest{Limit: 2}, attachmentcore.Page{Items: []model.Attachment{a, b}, NextCursor: &cursor}, nil)
	first := obj(call(alice, "task_attachment_list", args, false)["data"])
	items := first["items"].([]any)
	if len(items) != 2 || obj(items[0])["path"] != "a" || obj(items[1])["path"] != "b" {
		t.Fatalf("page: %+v", first)
	}
	mcpAttachmentCheck(t, first, map[string]any{"items": []any{mcpAttachmentWireExpected(a), mcpAttachmentWireExpected(b)}, "nextCursor": cursor})
	args["cursor"] = first["nextCursor"]
	ops.expectList(principal, projectID, parentID, model.PageRequest{Limit: 2, Cursor: &cursor}, attachmentcore.Page{Items: []model.Attachment{c}}, nil)
	tail := obj(call(alice, "task_attachment_list", args, false)["data"])
	if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["path"] != "c" || tail["nextCursor"] != nil {
		t.Fatalf("tail: %+v", tail)
	}
	mcpAttachmentCheck(t, tail, map[string]any{"items": []any{mcpAttachmentWireExpected(c)}, "nextCursor": nil})
	remove := map[string]any{"projectId": projectID, "taskId": parentID, "path": "b"}
	ops.expectDelete(bobPrincipal, projectID, parentID, "b", &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	if obj(call(bob, "task_attachment_remove", remove, true)["error"])["code"] != "not_found" {
		t.Fatal("unauthorized remove")
	}
	ops.expectDelete(principal, projectID, parentID, "b", nil)
	if obj(call(alice, "task_attachment_remove", remove, false)["data"])["removed"] != true {
		t.Fatal("missing remove receipt")
	}
	boundaryPath := strings.Repeat(strings.Repeat("😀", 50)+"/", 20) + "😀😀😀😀"
	contentType := "text/plain; x=" + strings.Repeat("a", 4000)
	boundary := item(boundaryPath, contentType, 1)
	ops.expectList(principal, projectID, parentID, model.PageRequest{Limit: 50}, attachmentcore.Page{Items: []model.Attachment{boundary}}, nil)
	boundaryPage := obj(call(alice, "task_attachment_list", map[string]any{"projectId": projectID, "taskId": parentID}, false)["data"])
	mcpAttachmentCheck(t, boundaryPage, map[string]any{"items": []any{mcpAttachmentWireExpected(boundary)}, "nextCursor": nil})
	boundaryItems := boundaryPage["items"].([]any)
	if len(boundaryItems) != 1 || obj(boundaryItems[0])["path"] != boundaryPath || obj(boundaryItems[0])["contentType"] != contentType || boundaryPage["nextCursor"] != nil {
		t.Fatalf("boundary page: %+v", boundaryPage)
	}
}
