package mcp

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type downloadSaturationAuth map[string]model.Principal

func (a downloadSaturationAuth) Authenticate(_ context.Context, _ model.CredentialKind, token string) (model.Principal, error) {
	if p, ok := a[token]; ok {
		return p, nil
	}
	return model.Principal{}, model.Unauthenticated(nil)
}

func TestDownloadSaturationPreservesTransferControl(t *testing.T) {
	fixture := newEntryFixture(t)
	alice := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTargetID}
	bob := model.Principal{Kind: model.PATCredential, UserID: testTeamID, CredentialID: testProjectID}
	fixture.entry.auth = downloadSaturationAuth{"alice": alice, "bob": bob}
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	newID := uuid.NewString()
	entered := make(chan string, 4)
	release := make(chan struct{})
	var saturated atomic.Bool
	var openCalls, started, closeCalls atomic.Int32
	downloads := attachmentReadOperations{t: t,
		read: func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
			closeCalls.Add(1)
			if ctx.Err() != nil || actor.Principal != alice || actor.AuthorityKind != "pat" || actor.AuthorityID != alice.CredentialID || input != (mcpdownload.Input{ProjectID: testProjectID, TaskID: testTargetID, Action: "close", TransferID: ids[0]}) {
				t.Errorf("unexpected control read: actor=%+v input=%+v", actor, input)
			}
			return map[string]any{"state": "cleanup_pending", "transferId": ids[0]}, nil
		},
		readAdmitted: func(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
			openCalls.Add(1)
			if actor.Principal != alice || actor.AuthorityKind != "pat" || actor.AuthorityID != alice.CredentialID || input.ProjectID != testProjectID || input.TaskID != testTargetID || input.Action != "open" || input.Path != "file" || input.Offset != "" || input.Format != "" || input.MaxBytes != 0 || admit == nil {
				t.Errorf("unexpected open: actor=%+v input=%+v", actor, input)
				return nil, errors.New("unexpected open")
			}
			if saturated.Load() && input.TransferID == ids[0] {
				return map[string]any{"state": "preparing", "transferId": ids[0]}, nil
			}
			if err := admit(ctx); err != nil {
				return nil, err
			}
			known := false
			for _, id := range ids {
				known = known || input.TransferID == id
			}
			if !known {
				t.Errorf("unexpected admitted transfer %s", input.TransferID)
				return nil, errors.New("unexpected transfer")
			}
			started.Add(1)
			entered <- input.TransferID
			select {
			case <-release:
				return map[string]any{"state": "readable", "transferId": input.TransferID}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	if err := RegisterDownloadTool(fixture.entry, downloads); err != nil {
		t.Fatal(err)
	}
	var uploadCalls atomic.Int32
	if err := RegisterUploadTools(fixture.entry, attachmentUploadOperation(func(ctx context.Context, actor transfercore.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
		want := []mcptransfer.UploadInput{{Action: "begin", Path: "upload", ContentType: "text/plain", TransferID: testUserID}, {Action: "status", TransferID: testUserID}, {Action: "abort", TransferID: testUserID}}
		index := int(uploadCalls.Add(1)) - 1
		if index >= len(want) || ctx.Err() != nil || actor.Principal != bob || actor.AuthorityKind != "pat" || actor.AuthorityID != bob.CredentialID || project != testTeamID || task != testUserID || input != want[index] {
			t.Errorf("unexpected upload control: actor=%+v project=%s task=%s input=%+v", actor, project, task, input)
			return nil, errors.New("unexpected upload control")
		}
		state := "receiving"
		if input.Action == "abort" {
			state = "cleanup_pending"
		}
		return map[string]any{"state": state, "transferId": testUserID}, nil
	})); err != nil {
		t.Fatal(err)
	}
	downloadClient := fixture.client(t, "2026-07-28", "alice")
	uploadClient := fixture.client(t, "2026-07-28", "bob")
	begin := map[string]any{"projectId": testTeamID, "taskId": testUserID, "action": "begin", "path": "upload", "contentType": "text/plain", "transferId": testUserID}
	if data := object(t, invitationCall(t, uploadClient, "task_attachment_put", begin, false)["data"]); data["state"] != "receiving" {
		t.Fatalf("begin: %#v", data)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	type result struct {
		id  string
		err error
	}
	results := make(chan result, 4)
	open := func(id string) map[string]any {
		return map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "open", "path": "file", "transferId": id}
	}
	for _, id := range ids {
		go func() {
			out, err := downloadClient.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_read", Arguments: open(id)})
			if err == nil && (out == nil || out.IsError) {
				err = fmt.Errorf("open %s returned failure", id)
			}
			results <- result{id: id, err: err}
		}()
	}
	for range ids {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("downloads did not enter admitted operations")
		}
	}
	saturated.Store(true)
	busy := object(t, invitationCall(t, downloadClient, "task_attachment_read", open(newID), true)["error"])
	if busy["code"] != "resource_busy" || started.Load() != 4 {
		t.Fatalf("new open: %#v started=%d", busy, started.Load())
	}
	status := object(t, invitationCall(t, downloadClient, "task_attachment_read", open(ids[0]), false)["data"])
	if status["state"] != "preparing" || status["transferId"] != ids[0] {
		t.Fatalf("repeat open: %#v", status)
	}
	for _, action := range []string{"status", "abort"} {
		args := map[string]any{"projectId": testTeamID, "taskId": testUserID, "action": action, "transferId": testUserID}
		data := object(t, invitationCall(t, uploadClient, "task_attachment_put", args, false)["data"])
		want := "receiving"
		if action == "abort" {
			want = "cleanup_pending"
		}
		if data["state"] != want {
			t.Fatalf("upload %s: %#v", action, data)
		}
	}
	closed := object(t, invitationCall(t, downloadClient, "task_attachment_read", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "close", "transferId": ids[0]}, false)["data"])
	if closed["state"] != "cleanup_pending" {
		t.Fatalf("download close: %#v", closed)
	}
	close(release)
	released = true
	for range ids {
		select {
		case out := <-results:
			if out.err != nil {
				t.Fatal(out.err)
			}
		case <-ctx.Done():
			t.Fatal("downloads did not finish")
		}
	}
	if openCalls.Load() != 6 || started.Load() != 4 || closeCalls.Load() != 1 || uploadCalls.Load() != 3 {
		t.Fatalf("calls: open=%d started=%d close=%d upload=%d", openCalls.Load(), started.Load(), closeCalls.Load(), uploadCalls.Load())
	}
}
