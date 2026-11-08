package mcp

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPDownloadRejectsDeletedProject(t *testing.T) {
	ctx := context.Background()
	tasks, db, project, _, owner := testsupport.TaskService(t)
	live := testsupport.CreateTask(t, tasks, owner, project.ID, "live")
	historical := testsupport.CreateTask(t, tasks, owner, project.ID, "historical")
	token := secretutil.Random("dnpat_")
	if _, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'MCP download test',now())`, uuid.NewString(), owner.UserID, secretutil.Hash(token)); err != nil {
		t.Fatal(err)
	}
	oauthToken, grantID := secretutil.Random(model.OAuthAccessPrefix), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'test','{}','https://daynight.test/mcp','daynight:mcp',now(),now()+interval '1 hour')`, grantID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, uuid.NewString(), grantID, owner.UserID, secretutil.Hash(oauthToken)); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	lifecycle, err := mcptransfer.New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	attachments := attachmentservice.NewAttachments(db, db, files)
	for _, id := range []string{live.ID, historical.ID} {
		if _, _, err = attachments.Put(ctx, owner, project.ID, id, "content.txt", "text/plain", strings.NewReader("private content")); err != nil {
			t.Fatal(err)
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(identityservice.New(db, nil, ""), "https://daynight.test", nil, logger, oauthservice.NewAuthenticator(db))
	if err != nil {
		t.Fatal(err)
	}
	if err = RegisterDownloadTool(entry, mcpdownload.New(attachments, lifecycle, files)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, entry))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		server.Close()
	})
	fixture := &entryFixture{entry: entry, server: server}
	client := fixture.client(t, "2026-07-28", token)
	oauthClient := fixture.client(t, "2026-07-28", oauthToken)
	args := func(taskID string, fields map[string]any) map[string]any {
		out := map[string]any{"projectId": project.ID, "taskId": taskID}
		for key, value := range fields {
			out[key] = value
		}
		return out
	}
	first, second := uuid.NewString(), uuid.NewString()
	pairs := []struct {
		task, transfer string
		client         *sdk.ClientSession
	}{{live.ID, first, client}, {historical.ID, second, oauthClient}}
	for _, pair := range pairs {
		data := object(t, invitationCall(t, pair.client, "task_attachment_read", args(pair.task, map[string]any{"action": "open", "path": "content.txt", "transferId": pair.transfer}), false)["data"])
		if data["state"] != "readable" || data["transferId"] != pair.transfer {
			t.Fatalf("open snapshot: %#v", data)
		}
	}
	before := object(t, invitationCall(t, client, "task_attachment_read", args(live.ID, map[string]any{"action": "chunk", "transferId": first, "offset": "0", "format": "text"}), false)["data"])
	if before["text"] != "private content" {
		t.Fatalf("snapshot content: %#v", before)
	}
	if err = tasks.Delete(ctx, owner, project.ID, historical.ID, taskcore.DeleteTask{Version: historical.Version}); err != nil {
		t.Fatal(err)
	}
	receipt, err := projectservice.NewProjects(db).Delete(ctx, owner, project.ID)
	if err != nil || !receipt.Deleted || receipt.ProjectID != project.ID {
		t.Fatalf("project delete: %+v %v", receipt, err)
	}
	for _, pair := range pairs {
		for name, fields := range map[string]map[string]any{
			"inspect":       {"action": "inspect", "path": "content.txt"},
			"inline":        {"action": "inline", "path": "content.txt", "format": "text"},
			"open-new":      {"action": "open", "path": "content.txt", "transferId": uuid.NewString()},
			"open-existing": {"action": "open", "path": "content.txt", "transferId": pair.transfer},
			"chunk":         {"action": "chunk", "transferId": pair.transfer, "offset": "0", "format": "text"},
			"close":         {"action": "close", "transferId": pair.transfer},
		} {
			t.Run(pair.task+"/"+name, func(t *testing.T) {
				out := invitationCall(t, pair.client, "task_attachment_read", args(pair.task, fields), true)
				if fault := object(t, out["error"]); fault["code"] != "not_found" {
					t.Fatalf("expected scoped not_found: %#v", out)
				}
				if out["data"] != nil {
					t.Fatalf("deleted content returned: %#v", out)
				}
			})
		}
	}
}
