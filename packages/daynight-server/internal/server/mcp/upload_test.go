package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type uploadFixture struct {
	calls         int
	actor         mcptransfer.Actor
	project, task string
	input         mcptransfer.UploadInput
	data          map[string]any
	err           error
}

type blockingUploads struct {
	entered chan string
	release chan struct{}
}

func (s *blockingUploads) Execute(ctx context.Context, _ mcptransfer.Actor, _, _ string, input mcptransfer.UploadInput) (map[string]any, error) {
	switch input.Action {
	case "inline", "chunk", "commit":
		s.entered <- input.Action
		select {
		case <-s.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return map[string]any{"state": "receiving", "nextOffset": "0"}, nil
}

func TestUploadContentSaturationPreservesControlCalls(t *testing.T) {
	f := newEntryFixture(t)
	s := &blockingUploads{entered: make(chan string, 4), release: make(chan struct{})}
	if err := RegisterUploadTools(f.entry, s); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	released := false
	defer func() {
		if !released {
			close(s.release)
		}
	}()
	base := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID}
	args := func(fields map[string]any) map[string]any {
		result := make(map[string]any, len(base)+len(fields))
		for k, v := range base {
			result[k] = v
		}
		for k, v := range fields {
			result[k] = v
		}
		return result
	}
	inline := args(map[string]any{"action": "inline", "path": "file", "contentType": "text/plain", "contentBase64": "YQ=="})
	chunk := args(map[string]any{"action": "chunk", "transferId": invitationTestProjectID, "chunkId": invitationTestTeamID, "offset": "0", "contentBase64": "YQ=="})
	commit := args(map[string]any{"action": "commit", "transferId": invitationTestProjectID, "totalBytes": "0"})
	results := make(chan error, 4)
	for _, input := range []map[string]any{inline, chunk, commit, commit} {
		go func() {
			result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: input})
			if err == nil && result.IsError {
				err = errors.New("content request failed")
			}
			results <- err
		}()
	}
	for range 4 {
		select {
		case <-s.entered:
		case <-ctx.Done():
			t.Fatal("content requests did not saturate the budget")
		}
	}
	busy := object(t, invitationCall(t, client, "task_attachment_put", inline, true)["error"])
	if busy["code"] != "resource_busy" {
		t.Fatalf("content budget was not bounded: %#v", busy)
	}
	for _, fields := range []map[string]any{
		{"action": "begin", "path": "file", "contentType": "text/plain", "transferId": invitationTestProjectID},
		{"action": "status", "transferId": invitationTestProjectID},
		{"action": "abort", "transferId": invitationTestProjectID},
	} {
		out := invitationCall(t, client, "task_attachment_put", args(fields), false)
		if object(t, out["data"])["state"] != "receiving" {
			t.Fatalf("control call blocked by content: %#v", out)
		}
	}
	close(s.release)
	released = true
	for range 4 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("content calls did not finish")
		}
	}
}

func (s *uploadFixture) Execute(_ context.Context, actor mcptransfer.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
	s.calls++
	s.actor, s.project, s.task, s.input = actor, project, task, input
	return s.data, s.err
}

func TestUploadToolBranchesAndActor(t *testing.T) {
	f := newEntryFixture(t)
	s := &uploadFixture{data: map[string]any{"state": "receiving", "nextOffset": "0"}}
	if err := RegisterUploadTools(f.entry, s); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	base := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID}
	for _, fields := range []map[string]any{
		{"action": "inline", "path": "文本", "contentType": "text/plain", "contentBase64": ""},
		{"action": "begin", "path": "文本", "contentType": "text/plain", "transferId": invitationTestProjectID},
		{"action": "chunk", "transferId": invitationTestProjectID, "chunkId": invitationTestTeamID, "offset": "0", "contentBase64": "YQ==", "sha256": strings.Repeat("a", 64)},
		{"action": "status", "transferId": invitationTestProjectID},
		{"action": "commit", "transferId": invitationTestProjectID, "totalBytes": "9007199254740993"},
		{"action": "abort", "transferId": invitationTestProjectID},
	} {
		args := make(map[string]any)
		for k, v := range base {
			args[k] = v
		}
		for k, v := range fields {
			args[k] = v
		}
		out := invitationCall(t, client, "task_attachment_put", args, false)
		if object(t, out["data"])["state"] != "receiving" || s.input.Action != fields["action"] || s.project != invitationTestProjectID || s.task != invitationTestTeamID {
			t.Fatalf("branch %v result=%#v input=%#v", fields, out, s.input)
		}
		if s.actor.Principal.UserID != "alice" || s.actor.AuthorityKind != "pat" || s.actor.AuthorityID != "credential-alice" {
			t.Fatalf("incorrect authority: %#v", s.actor)
		}
		if fields["action"] == "commit" && s.input.TotalBytes != "9007199254740993" {
			t.Fatalf("lost decimal precision: %#v", s.input)
		}
	}
	if s.calls != 6 {
		t.Fatalf("calls=%d", s.calls)
	}
}

func TestUploadToolSchemaAndFailureFacts(t *testing.T) {
	f := newEntryFixture(t)
	s := &uploadFixture{data: map[string]any{"transferId": invitationTestProjectID, "operationId": invitationTestTeamID, "writeOutcome": "unknown", "phase": "commit"}, err: &model.Fault{Code: "transfer_state_conflict", Message: "unknown"}}
	if err := RegisterUploadTools(f.entry, s); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "action": "commit", "transferId": invitationTestProjectID, "totalBytes": "0"}
	out := invitationCall(t, client, "task_attachment_put", args, true)
	fault := object(t, out["error"])
	refs := object(t, fault["refs"])
	if fault["writeOutcome"] != "unknown" || fault["phase"] != "commit" || refs["operationId"] != invitationTestTeamID {
		t.Fatalf("facts: %#v", fault)
	}
	for _, invalid := range []map[string]any{
		{"action": "begin", "transferId": invitationTestProjectID},
		{"action": "chunk", "transferId": invitationTestProjectID, "chunkId": invitationTestTeamID, "offset": "00", "contentBase64": "YQ=="},
		{"action": "chunk", "transferId": invitationTestProjectID, "chunkId": invitationTestTeamID, "offset": "0", "contentBase64": ""},
		{"action": "status", "transferId": invitationTestProjectID, "path": "unexpected"},
		{"action": "inline", "path": "file", "contentType": "text/plain", "contentBase64": strings.Repeat("A", 699053)},
	} {
		invalid["projectId"], invalid["taskId"] = invitationTestProjectID, invitationTestTeamID
		invitationCall(t, client, "task_attachment_put", invalid, true)
	}
	if s.calls != 1 {
		t.Fatalf("invalid input reached service: %d calls", s.calls)
	}
	// An unknown transaction for a transfer record is not by itself evidence
	// that the target attachment write was started or committed.
	s.data = nil
	s.err = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("transfer transaction result unknown")}
	args["action"] = "status"
	delete(args, "totalBytes")
	unknown := object(t, invitationCall(t, client, "task_attachment_put", args, true)["error"])
	if unknown["writeOutcome"] != nil {
		t.Fatalf("transaction result misclassified as attachment result: %#v", unknown)
	}
}

func TestUploadErrorRetainsConfirmedAttachmentReceipt(t *testing.T) {
	f := newEntryFixture(t)
	s := &uploadFixture{data: map[string]any{
		"transferId": invitationTestProjectID, "operationId": invitationTestTeamID,
		"writeOutcome": "confirmed", "attachment": map[string]any{"path": "file", "sizeBytes": "0"}, "created": false,
	}, err: errors.New("cleanup failed")}
	if err := RegisterUploadTools(f.entry, s); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := map[string]any{"projectId": invitationTestProjectID, "taskId": invitationTestTeamID, "action": "commit", "transferId": invitationTestProjectID, "totalBytes": "0"}
	fault := object(t, invitationCall(t, client, "task_attachment_put", args, true)["error"])
	refs := object(t, fault["refs"])
	if fault["writeOutcome"] != "confirmed" || refs["created"] != false || object(t, refs["attachment"])["path"] != "file" {
		t.Fatalf("confirmed receipt lost: %#v", fault)
	}
	s.data["writeOutcome"] = "unknown"
	fault = object(t, invitationCall(t, client, "task_attachment_put", args, true)["error"])
	refs = object(t, fault["refs"])
	if _, exists := refs["attachment"]; exists {
		t.Fatalf("unconfirmed attachment was exposed: %#v", fault)
	}
	if _, exists := refs["created"]; exists {
		t.Fatalf("unconfirmed creation was exposed: %#v", fault)
	}
}

func TestUploadRegistrationRejectsInvalidDefinition(t *testing.T) {
	if err := RegisterUploadTools(newEntryFixture(t).entry, nil); err == nil {
		t.Fatal("missing service accepted")
	}
	original := uploadToolsJSON
	t.Cleanup(func() { uploadToolsJSON = original })
	for _, raw := range []string{"[", "[]", `[{"name":"other"}]`} {
		uploadToolsJSON = []byte(raw)
		if err := RegisterUploadTools(newEntryFixture(t).entry, &uploadFixture{}); err == nil {
			t.Fatalf("definition %q accepted: %v", raw, err)
		}
	}
}
