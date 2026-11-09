package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
