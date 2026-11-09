package mcp

import (
	"context"
	"reflect"
	"testing"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

func TestMCPUploadMapsDeletedProjectRefusals(t *testing.T) {
	f := newEntryFixture(t)
	var expected mcptransfer.UploadInput
	var expectedTask string
	calls := 0
	if err := RegisterUploadTools(f.entry, attachmentUploadOperation(func(ctx context.Context, actor transfercore.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
		calls++
		if ctx.Err() != nil || actor.Principal.UserID != "alice" || actor.AuthorityKind != "pat" || actor.AuthorityID != "credential-alice" || project != testProjectID || task != expectedTask || !reflect.DeepEqual(input, expected) {
			t.Errorf("incorrect upload: actor=%+v project=%s task=%s input=%+v want=%+v", actor, project, task, input, expected)
		}
		return nil, &model.Fault{Code: "not_found", Message: "Project not found."}
	})); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	invoke := func(task string, input mcptransfer.UploadInput) {
		t.Helper()
		expected, expectedTask = input, task
		args := map[string]any{"projectId": testProjectID, "taskId": task, "action": input.Action, "transferId": input.TransferID}
		switch input.Action {
		case "begin":
			args["path"], args["contentType"] = input.Path, input.ContentType
		case "chunk":
			args["chunkId"], args["offset"], args["contentBase64"] = input.ChunkID, input.Offset, input.ContentBase64
		case "commit":
			args["totalBytes"] = input.TotalBytes
		case "inline":
			delete(args, "transferId")
			args["path"], args["contentType"], args["contentBase64"] = input.Path, input.ContentType, input.ContentBase64
		}
		out := invitationCall(t, client, "task_attachment_put", args, true)
		if object(t, out["error"])["code"] != "not_found" || out["data"] != nil {
			t.Fatalf("scoped refusal: %#v", out)
		}
	}
	checkMissing := func(label string) {
		for _, action := range []string{"status", "chunk", "commit", "abort"} {
			t.Run(label+"/"+action, func(t *testing.T) {
				input := mcptransfer.UploadInput{Action: action, TransferID: uuid.NewString()}
				if action == "chunk" {
					input.ChunkID, input.Offset, input.ContentBase64 = uuid.NewString(), "0", "YQ=="
				}
				if action == "commit" {
					input.TotalBytes = "0"
				}
				invoke(testTargetID, input)
			})
		}
	}
	checkMissing("live-project-missing")
	for _, task := range []string{testTargetID, testTeamID} {
		for _, input := range []mcptransfer.UploadInput{
			{Action: "begin", Path: "late.txt", ContentType: "text/plain", TransferID: uuid.NewString()},
			{Action: "status", TransferID: testUserID},
			{Action: "chunk", TransferID: testUserID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="},
			{Action: "commit", TransferID: testUserID, TotalBytes: "0"},
			{Action: "abort", TransferID: testUserID},
			{Action: "inline", Path: "late.txt", ContentType: "text/plain", ContentBase64: "YQ=="},
		} {
			t.Run(task+"/"+input.Action, func(t *testing.T) { invoke(task, input) })
		}
	}
	checkMissing("deleted-project-missing")
	if calls != 20 {
		t.Fatalf("upload calls=%d", calls)
	}
}
