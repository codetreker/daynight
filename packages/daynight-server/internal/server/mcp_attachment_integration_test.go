package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPAttachmentProductionLifecycle(t *testing.T) {
	database := newHTTPTestStore(t)
	principal := defaultHTTPPrincipal()
	bobPrincipal := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	tokens := []string{defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"}
	configureMCPPrincipals(t, database, map[string]model.Principal{tokens[0]: principal, tokens[1]: bobPrincipal})
	files := attachmentTestFiles(t)
	production, _ := newMCPHTTPServer(t, database, files)
	origin := production.URL
	alice, bob := mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])
	projectID := "e5555555-5555-4555-8555-555555555555"
	parentID := "f6666666-6666-4666-8666-666666666666"
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	item := func(path, contentType string, size int64) model.Attachment {
		return model.Attachment{ProjectID: projectID, TaskID: parentID, Path: path, ContentType: contentType, SizeBytes: size, CreatedAt: at, UpdatedAt: at}
	}
	seed := func(path, content string) {
		t.Helper()
		address, err := attachmentcore.NewAddress(projectID, parentID, path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = files.Put(t.Context(), attachmentcore.Bucket, address.StoragePath, strings.NewReader(content)); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"a", "b", "c"} {
		seed(path, "body-"+path)
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
	mcpAttachmentDenyRead(t, database, bobPrincipal, projectID)
	denied := call(bob, "task_attachment_list", args, true)
	if obj(denied["error"])["code"] != "not_found" {
		t.Fatalf("denied: %+v", denied)
	}
	a, b, c := item("a", "text/plain", 6), item("b", "text/plain", 6), item("c", "text/plain", 6)
	mcpAttachmentPage(t, database, principal, projectID, parentID, "", 2, store.AttachmentPage{Items: []model.Attachment{a, b}, HasMore: true})
	first := obj(call(alice, "task_attachment_list", args, false)["data"])
	items := first["items"].([]any)
	if len(items) != 2 || obj(items[0])["path"] != "a" || obj(items[1])["path"] != "b" {
		t.Fatalf("page: %+v", first)
	}
	args["cursor"] = first["nextCursor"]
	mcpAttachmentPage(t, database, principal, projectID, parentID, "b", 2, store.AttachmentPage{Items: []model.Attachment{c}})
	tail := obj(call(alice, "task_attachment_list", args, false)["data"])
	if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["path"] != "c" || tail["nextCursor"] != nil {
		t.Fatalf("tail: %+v", tail)
	}
	remove := map[string]any{"projectId": projectID, "taskId": parentID, "path": "b"}
	mcpAttachmentDenyMutation(t, database, bobPrincipal, projectID, parentID)
	if obj(call(bob, "task_attachment_remove", remove, true)["error"])["code"] != "not_found" {
		t.Fatal("unauthorized remove")
	}
	removeCalls := newHTTPCallPlan(t, map[string]int{"metadata": 1, "delete": 1})
	mcpAttachmentMutation(t, database, principal, projectID, parentID, &mcpAttachmentDAO{t: t, AttachmentCall: func(ctx context.Context, pid, tid, path string) (model.Attachment, error) {
		removeCalls.Called("metadata")
		mcpAttachmentCheck(t, []string{pid, tid, path}, []string{projectID, parentID, "b"})
		return b, nil
	}, DeleteCall: func(ctx context.Context, pid, tid, path string) error {
		removeCalls.Called("delete")
		mcpAttachmentCheck(t, []string{pid, tid, path}, []string{projectID, parentID, "b"})
		return nil
	}}, true)
	if obj(call(alice, "task_attachment_remove", remove, false)["data"])["removed"] != true {
		t.Fatal("missing remove receipt")
	}
	address, err := attachmentcore.NewAddress(projectID, parentID, "b")
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath); err == nil {
		opened.Body.Close()
		t.Fatal("deleted attachment bytes still open")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	boundaryPath := strings.Repeat(strings.Repeat("😀", 50)+"/", 20) + "😀😀😀😀"
	contentType := "text/plain; x=" + strings.Repeat("a", 4000)
	seed(boundaryPath, "x")
	boundary := item(boundaryPath, contentType, 1)
	mcpAttachmentPage(t, database, principal, projectID, parentID, "", 50, store.AttachmentPage{Items: []model.Attachment{boundary}})
	boundaryPage := obj(call(alice, "task_attachment_list", map[string]any{"projectId": projectID, "taskId": parentID}, false)["data"])
	boundaryItems := boundaryPage["items"].([]any)
	if len(boundaryItems) != 1 || obj(boundaryItems[0])["path"] != boundaryPath || obj(boundaryItems[0])["contentType"] != contentType || boundaryPage["nextCursor"] != nil {
		t.Fatalf("boundary page: %+v", boundaryPage)
	}
}
