package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type attachmentTestOperations struct {
	items     []model.Attachment
	err       error
	calls     int
	principal model.Principal
	request   model.PageRequest
	removed   string
}

func (s *attachmentTestOperations) List(_ context.Context, principal model.Principal, project, task string, request model.PageRequest) (attachmentcore.Page, error) {
	s.calls++
	s.principal, s.request = principal, request
	if s.err != nil {
		return attachmentcore.Page{}, s.err
	}
	query, err := attachmentcore.ListQuery(request, project, task)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	items := make([]model.Attachment, 0, request.Limit)
	more := false
	for _, item := range s.items {
		if query.After != nil && item.Path <= *query.After {
			continue
		}
		if len(items) == request.Limit {
			more = true
			break
		}
		items = append(items, item)
	}
	return attachmentcore.MakePage(store.AttachmentPage{Items: items, HasMore: more}, project, task)
}
func (s *attachmentTestOperations) Delete(_ context.Context, principal model.Principal, project, task, path string) error {
	s.calls++
	s.principal, s.removed = principal, path
	return s.err
}

func TestAttachmentToolsPaginationAndRemoval(t *testing.T) {
	fixture := newEntryFixture(t)
	s := &attachmentTestOperations{}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 80; i++ {
		s.items = append(s.items, model.Attachment{Path: fmt.Sprintf("%03d-%s", i, strings.Repeat("a", 180)), ContentType: "text/plain", SizeBytes: 9007199254740993, CreatedAt: now, UpdatedAt: now})
	}
	if err := RegisterAttachmentTools(fixture.entry, s); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	args := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "limit": 100}
	seen := []string{}
	for {
		out := invitationCall(t, client, "task_attachment_list", args, false)
		data := object(t, out["data"])
		items := data["items"].([]any)
		for _, raw := range items {
			item := object(t, raw)
			if item["sizeBytes"] != "9007199254740993" || item["contentType"] != "text/plain" {
				t.Fatalf("metadata: %#v", item)
			}
			seen = append(seen, item["path"].(string))
		}
		if data["nextCursor"] == nil {
			break
		}
		args["cursor"] = data["nextCursor"]
	}
	if len(seen) != len(s.items) {
		t.Fatalf("got %d attachments, want %d", len(seen), len(s.items))
	}
	for i := range seen {
		if seen[i] != s.items[i].Path {
			t.Fatalf("page omitted or repeated item %d", i)
		}
	}
	if s.principal.UserID != "alice" || s.request.Limit != 100 {
		t.Fatalf("wrong actor or limit: %#v %#v", s.principal, s.request)
	}
	out := invitationCall(t, client, "task_attachment_remove", map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "path": "docs/你好"}, false)
	if object(t, out["data"])["removed"] != true || s.removed != "docs/你好" || object(t, out["meta"])["outcome"] != "changed" {
		t.Fatalf("remove: %#v", out)
	}
}

func TestAttachmentToolsErrorsAndUnknown(t *testing.T) {
	fixture := newEntryFixture(t)
	s := &attachmentTestOperations{}
	if err := RegisterAttachmentTools(fixture.entry, s); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	args := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "path": "../bad"}
	out := invitationCall(t, client, "task_attachment_remove", args, true)
	if fault := object(t, out["error"]); fault["code"] != "invalid_input" || fault["writeOutcome"] != "not_committed" || s.calls != 0 {
		t.Fatalf("invalid: %#v calls=%d", fault, s.calls)
	}
	args["path"] = "file"
	s.err = &store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, Cause: errors.New("metadata rolled back after file deletion")}
	out = invitationCall(t, client, "task_attachment_remove", args, true)
	if fault := object(t, out["error"]); fault["writeOutcome"] != "not_committed" || fault["requestId"] == "" || object(t, fault["refs"])["path"] != "file" {
		t.Fatalf("failure before file effect: %#v", fault)
	}
	s.err = nil
	out = invitationCall(t, client, "task_attachment_list", map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "cursor": "bad"}, true)
	if fault := object(t, out["error"]); fault["code"] != "invalid_input" || fault["writeOutcome"] != nil {
		t.Fatalf("cursor: %#v", fault)
	}
	calls := s.calls
	invitationCall(t, client, "task_attachment_list", map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "limit": 101}, true)
	if s.calls != calls {
		t.Fatal("invalid schema reached service")
	}
}

func TestAttachmentToolRegistrationFailures(t *testing.T) {
	fixture := newEntryFixture(t)
	if err := RegisterAttachmentTools(fixture.entry, nil); err == nil {
		t.Fatal("missing service accepted")
	}
	original := attachmentToolsJSON
	t.Cleanup(func() { attachmentToolsJSON = original })
	for _, tc := range []struct{ name, definition string }{
		{"invalid JSON", `[`},
		{"unknown tool", `[{"name":"unexpected","inputSchema":{"type":"object"},"outputSchema":{"type":"object"}}]`},
		{"invalid schema", `[{"name":"task_attachment_list","inputSchema":{"type":"string"},"outputSchema":{"type":"object"}}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attachmentToolsJSON = []byte(tc.definition)
			if err := RegisterAttachmentTools(fixture.entry, &attachmentTestOperations{}); err == nil {
				t.Fatal("invalid tool registration accepted")
			}
		})
	}
}

func TestMCPAttachmentProductionLifecycle(t *testing.T) {
	database := newTransferTestStore(t)
	principal := defaultHTTPPrincipal()
	bobPrincipal := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	tokens := []string{defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"}
	files := attachmentTestFiles(t)
	production := newTransferAdapterHost(t, database, files, map[string]model.Principal{tokens[0]: principal, tokens[1]: bobPrincipal}, "attachment")
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
