package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func TestDownloadMetadataDoesNotRequireLargeMaterialization(t *testing.T) {
	entry := newEntryFixture(t)
	var expected mcpdownload.Input
	calls, admitted := 0, 0
	read := func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
		calls++
		if ctx.Err() != nil || actor.Principal.UserID != "alice" || actor.AuthorityKind != "pat" || actor.AuthorityID != "credential-alice" || input != expected {
			t.Errorf("unexpected metadata call: actor=%+v input=%+v want=%+v", actor, input, expected)
		}
		return map[string]any{"attachment": map[string]any{"path": "file", "contentType": "text/plain", "sizeBytes": "8"}, "contentIncluded": false}, nil
	}
	if err := RegisterDownloadTool(entry.entry, attachmentReadOperations{t: t, read: read, readAdmitted: func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
		admitted++
		if admit == nil {
			t.Error("open omitted admission callback")
		}
		return read(ctx, actor, input)
	}}); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	release, err := entry.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, action := range []string{"", "inspect", "open"} {
		expected = mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "file", Action: action}
		input := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "file"}
		if action != "" {
			input["action"] = action
		}
		if action == "open" {
			input["transferId"], expected.TransferID = testTeamID, testTeamID
		}
		out := invitationCall(t, client, "task_attachment_read", input, false)
		encoded, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("%s result size=%d err=%v", action, len(encoded), err)
		}
	}
	if calls != 3 || admitted != 1 {
		t.Fatalf("metadata calls=%d admitted=%d", calls, admitted)
	}
}
