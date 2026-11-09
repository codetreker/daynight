package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func TestDownloadMetadataAndErrorsAreBounded(t *testing.T) {
	entry := newEntryFixture(t)
	var expected mcpdownload.Input
	var data map[string]any
	var failure error
	calls := 0
	read := func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
		calls++
		if ctx.Err() != nil || actor.Principal.UserID != "alice" || actor.AuthorityKind != "pat" || actor.AuthorityID != "credential-alice" || input != expected {
			t.Errorf("incorrect read call: actor=%+v input=%+v want=%+v", actor, input, expected)
		}
		return data, failure
	}
	if err := RegisterDownloadTool(entry.entry, attachmentReadOperations{t: t, read: read, readAdmitted: func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
		if admit == nil {
			t.Error("open omitted admission callback")
		}
		return read(ctx, actor, input)
	}}); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	largeRelease, err := entry.entry.budget.Acquire(t.Context(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer largeRelease()
	invoke := func(action, path string, wantError bool) map[string]any {
		t.Helper()
		expected = mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: action, Path: path}
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": path}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"], expected.TransferID = testTeamID, testTeamID
		}
		out := invitationCall(t, client, "task_attachment_read", args, wantError)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 {
			t.Fatalf("%s response exceeds encoded limit: %d %v", action, len(encoded), err)
		}
		return out
	}
	data = map[string]any{"attachment": map[string]any{"path": "file", "contentType": `text/plain; name="` + strings.Repeat("<", 1300) + `"`}, "contentIncluded": false}
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, "file", false)
		if object(t, out["data"])["contentIncluded"] != false {
			t.Fatalf("metadata included bytes: %#v", out)
		}
	}
	data, failure = nil, &model.Fault{Code: "resource_conflict", Message: "Attachment metadata exceeds the read limit."}
	for _, action := range []string{"", "inspect", "open"} {
		if out := invoke(action, "file", true); object(t, out["error"])["code"] != "resource_conflict" {
			t.Fatalf("metadata refusal: %#v", out)
		}
	}
	longValidPath := strings.TrimSuffix(strings.Repeat(strings.Repeat("<", 90)+"/", 10), "/")
	data, failure = map[string]any{"attachment": map[string]any{"path": longValidPath, "contentType": `text/plain; name="` + strings.Repeat("<", 1900) + `"`}}, nil
	for _, action := range []string{"", "inspect", "open"} {
		if out := invoke(action, longValidPath, true); object(t, out["error"])["code"] != "payload_too_large" {
			t.Fatalf("encoded metadata limit: %#v", out)
		}
	}
	before := calls
	longPath := strings.Repeat("a/", 15000) + "marker"
	for _, action := range []string{"", "inspect", "open"} {
		out := invoke(action, longPath, true)
		encoded, _ := json.Marshal(out)
		if object(t, out["error"])["code"] != "invalid_input" || strings.Contains(string(encoded), "marker") || strings.Contains(string(encoded), strings.Repeat("a/", 100)) {
			t.Fatalf("oversized path echoed: %s", encoded)
		}
	}
	if calls != before || calls != 9 {
		t.Fatalf("service calls=%d want=%d", calls, before)
	}
}

type escapedMetadataReader struct{ count int }

func (s *escapedMetadataReader) Read(_ context.Context, _ mcptransfer.Actor, _ mcpdownload.Input) (map[string]any, error) {
	return map[string]any{"attachment": map[string]any{"path": "file", "contentType": strings.Repeat("<", s.count)}}, nil
}
func (s *escapedMetadataReader) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, _ func(context.Context) error) (map[string]any, error) {
	return s.Read(ctx, actor, input)
}

func TestDownloadEncodedMetadataBudget(t *testing.T) {
	entry := newEntryFixture(t)
	reader := &escapedMetadataReader{}
	if err := RegisterDownloadTool(entry.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect", "open"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": "file"}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"] = testTeamID
		}
		reader.count = 2000
		out := invitationCall(t, client, "task_attachment_read", args, false)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 {
			t.Fatalf("%s valid output exceeds budget: %d %v", action, len(encoded), err)
		}
		reader.count = 3000
		out = invitationCall(t, client, "task_attachment_read", args, true)
		encoded, err = json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 || object(t, out["error"])["code"] != "payload_too_large" {
			t.Fatalf("%s oversize result: %d %s %v", action, len(encoded), encoded, err)
		}
	}
}

func TestDownloadOverlongPathNeverReachesService(t *testing.T) {
	entry := newEntryFixture(t)
	reader := &downloadTestReader{}
	if err := RegisterDownloadTool(entry.entry, reader); err != nil {
		t.Fatal(err)
	}
	client := entry.client(t, "2026-07-28", "alice")
	for _, action := range []string{"", "inspect", "inline", "open"} {
		args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "path": strings.Repeat("界", 1366)}
		if action != "" {
			args["action"] = action
		}
		if action == "open" {
			args["transferId"] = testTeamID
		}
		out := invitationCall(t, client, "task_attachment_read", args, true)
		encoded, err := json.Marshal(out)
		if err != nil || len(encoded) > 16<<10 || object(t, out["error"])["code"] != "invalid_input" || reader.calls != 0 {
			t.Fatalf("%s: oversized path reached service or response: %s %v", action, encoded, err)
		}
	}
}
