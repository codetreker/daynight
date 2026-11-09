package mcp

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPDownloadMapsDeletedProjectRefusals(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.oauth = downloadTestOAuth{}
	var expected mcpdownload.Input
	var expectedActor mcptransfer.Actor
	calls, admittedCalls := 0, 0
	refuse := func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
		calls++
		if ctx.Err() != nil || !reflect.DeepEqual(actor, expectedActor) || input != expected {
			t.Errorf("incorrect read call: actor=%+v want=%+v input=%+v want=%+v", actor, expectedActor, input, expected)
		}
		return nil, &model.Fault{Code: "not_found", Message: "Project not found."}
	}
	if err := RegisterDownloadTool(f.entry, attachmentReadOperations{t: t, read: refuse, readAdmitted: func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
		admittedCalls++
		if admit == nil {
			t.Error("open omitted admission callback")
		}
		return refuse(ctx, actor, input)
	}}); err != nil {
		t.Fatal(err)
	}
	pairs := []struct {
		task   string
		client *sdk.ClientSession
		actor  mcptransfer.Actor
	}{
		{testTargetID, f.client(t, "2026-07-28", "alice"), mcptransfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: "alice", CredentialID: "credential-alice"}, AuthorityKind: "pat", AuthorityID: "credential-alice"}},
		{testTeamID, f.client(t, "2026-07-28", model.OAuthAccessPrefix+"download"), mcptransfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}, AuthorityKind: "oauth", AuthorityID: testTeamID}},
	}
	for _, pair := range pairs {
		for _, tc := range []struct {
			name  string
			input mcpdownload.Input
		}{
			{"inspect", mcpdownload.Input{Action: "inspect", Path: "content.txt"}},
			{"inline", mcpdownload.Input{Action: "inline", Path: "content.txt", Format: "text"}},
			{"open-new", mcpdownload.Input{Action: "open", Path: "content.txt", TransferID: uuid.NewString()}},
			{"open-existing", mcpdownload.Input{Action: "open", Path: "content.txt", TransferID: testUserID}},
			{"chunk", mcpdownload.Input{Action: "chunk", TransferID: testUserID, Offset: "0", Format: "text"}},
			{"close", mcpdownload.Input{Action: "close", TransferID: testUserID}},
		} {
			t.Run(pair.task+"/"+tc.name, func(t *testing.T) {
				expected, expectedActor = tc.input, pair.actor
				expected.ProjectID, expected.TaskID = testProjectID, pair.task
				args := map[string]any{"projectId": testProjectID, "taskId": pair.task, "action": tc.input.Action}
				if tc.input.Path != "" {
					args["path"] = tc.input.Path
				}
				if tc.input.TransferID != "" {
					args["transferId"] = tc.input.TransferID
				}
				if tc.input.Offset != "" {
					args["offset"] = tc.input.Offset
				}
				if tc.input.Format != "" {
					args["format"] = tc.input.Format
				}
				out := invitationCall(t, pair.client, "task_attachment_read", args, true)
				if object(t, out["error"])["code"] != "not_found" || out["data"] != nil {
					t.Fatalf("scoped refusal: %#v", out)
				}
			})
		}
	}
	if calls != 12 || admittedCalls != 4 {
		t.Fatalf("read calls=%d admitted=%d", calls, admittedCalls)
	}
}
