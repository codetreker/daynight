package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type downloadTestReader struct {
	actor mcptransfer.Actor
	input mcpdownload.Input
	calls int
	err   error
}

func (s *downloadTestReader) Read(_ context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
	s.actor, s.input = actor, input
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return map[string]any{"sizeBytes": "4", "contentIncluded": false, "contentRef": map[string]any{"projectId": input.ProjectID, "taskId": input.TaskID, "path": input.Path}}, nil
}
func (s *downloadTestReader) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, _ func(context.Context) error) (map[string]any, error) {
	return s.Read(ctx, actor, input)
}

type downloadTestOAuth struct{}

func (downloadTestOAuth) AuthenticateAccess(context.Context, string, string) (store.OAuthAccessIdentity, error) {
	return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}, GrantID: testTeamID}, nil
}

func TestDownloadToolContract(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.oauth = downloadTestOAuth{}
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	listing, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tool := range listing.Tools {
		if tool.Name == "task_attachment_read" {
			found = true
		}
	}
	if !found {
		t.Fatal("download tool was not discoverable")
	}
	call := func(args map[string]any, wantError bool) map[string]any {
		t.Helper()
		return invitationCall(t, client, "task_attachment_read", args, wantError)
	}
	valid := []struct {
		args map[string]any
		want mcpdownload.Input
	}{
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "a.txt"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt"}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "inspect", "path": "a.txt"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "inspect"}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "inline", "path": "a.txt", "format": "text", "maxBytes": 13}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "inline", Format: "text", MaxBytes: 13}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "open", "path": "a.txt", "transferId": testTeamID}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Path: "a.txt", Action: "open", TransferID: testTeamID}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "9007199254740993", "maxBytes": 524288, "format": "base64"}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: "chunk", TransferID: testTeamID, Offset: "9007199254740993", Format: "base64", MaxBytes: 524288}},
		{map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID}, mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: "close", TransferID: testTeamID}},
	}
	for _, tc := range valid {
		out := call(tc.args, false)
		if reader.input != tc.want {
			t.Fatalf("input lost or changed: got %+v, want %+v", reader.input, tc.want)
		}
		data, meta := object(t, out["data"]), object(t, out["meta"])
		if data["sizeBytes"] != "4" || data["contentIncluded"] != false || meta["requestId"] != "test-request" {
			t.Fatalf("response: %#v", out)
		}
		if reader.actor.Principal.UserID != "alice" || reader.actor.AuthorityKind != "pat" || reader.actor.AuthorityID != "credential-alice" {
			t.Fatalf("PAT actor: %+v", reader.actor)
		}
	}
	invalid := []map[string]any{
		{"projectId": testProjectID, "taskId": testTargetID},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "open", "path": "a.txt"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "01"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "chunk", "transferId": testTeamID, "offset": "0", "maxBytes": 524289},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "inline", "path": "a.txt", "format": "binary"},
		{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID, "path": "a.txt"},
	}
	for _, args := range invalid {
		before := reader.calls
		out := call(args, true)
		if object(t, out["error"])["code"] != "invalid_input" || reader.calls != before {
			t.Fatalf("invalid input reached service: args=%v result=%v", args, out)
		}
	}
	reader.err = &model.Fault{Code: "forbidden", Message: "Access denied."}
	out := call(valid[4].args, true)
	failure := object(t, out["error"])
	refs := object(t, failure["refs"])
	if failure["code"] != "forbidden" || failure["requestId"] != "test-request" || failure["writeOutcome"] != nil || refs["transferId"] != testTeamID {
		t.Fatalf("error envelope: %#v", failure)
	}
	reader.err = nil
	oauth := f.client(t, "2025-11-25", model.OAuthAccessPrefix+"test")
	invitationCall(t, oauth, "task_attachment_read", valid[0].args, false)
	if reader.actor.Principal.CredentialID != testTargetID || reader.actor.AuthorityKind != "oauth" || reader.actor.AuthorityID != testTeamID {
		t.Fatalf("OAuth grant identity lost: %+v", reader.actor)
	}
}

func TestDownloadToolBudget(t *testing.T) {
	f := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, action := range []string{"inspect", "open", "close", "inline", "chunk"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": action}
		switch action {
		case "inspect", "inline":
			args["path"] = "a.txt"
		case "open":
			args["path"], args["transferId"] = "a.txt", testTeamID
		case "close":
			args["transferId"] = testTeamID
		case "chunk":
			args["transferId"], args["offset"] = testTeamID, "0"
		}
		busy := action == "inline" || action == "chunk"
		before := reader.calls
		out := invitationCall(t, client, "task_attachment_read", args, busy)
		if busy && (object(t, out["error"])["code"] != "resource_busy" || reader.calls != before) {
			t.Fatalf("%s did not respect large budget: %#v", action, out)
		}
		if !busy && reader.calls != before+1 {
			t.Fatalf("%s did not use independent control budget", action)
		}
	}
}

func TestInspectUsesContentBudget(t *testing.T) {
	f := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		release, err := f.entry.budget.Acquire(t.Context(), BudgetContent)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "a.txt"}
		if action != "" {
			args["action"] = action
		}
		out := invitationCall(t, client, "task_attachment_read", args, true)
		if object(t, out["error"])["code"] != "resource_busy" || reader.calls != 0 {
			t.Fatalf("inspect admission: %#v", out)
		}
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": testTeamID}
	invitationCall(t, client, "task_attachment_read", args, false)
}

func TestDownloadToolRegistration(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterDownloadTool(f.entry, nil); err == nil {
		t.Fatal("nil download service accepted")
	}
	original := downloadToolsJSON
	t.Cleanup(func() { downloadToolsJSON = original })
	for _, definition := range []string{"[", "[]", `[{"name":"other"}]`} {
		downloadToolsJSON = []byte(definition)
		if err := RegisterDownloadTool(f.entry, &downloadTestReader{}); err == nil {
			t.Fatalf("invalid definition accepted: %s", definition)
		}
	}
}
