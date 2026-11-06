package mcp

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestMCPUploadRejectsDeletedProject(t *testing.T) {
	ctx := context.Background()
	tasks, db, project, _, owner := testsupport.TaskService(t)
	live := testsupport.CreateTask(t, tasks, owner, project.ID, "live")
	historical := testsupport.CreateTask(t, tasks, owner, project.ID, "historical")
	token := secretutil.Random("dnpat_")
	tokenID := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'MCP test',now())`, tokenID, owner.UserID, secretutil.Hash(token)); err != nil {
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
	lifecycle, err := transfer.New(db, files, files, 1<<30, 0)
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
	uploads := transfer.NewUploads(lifecycle, files, attachmentservice.NewAttachments(db, db, files))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(identityservice.New(db, nil, ""), "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = RegisterUploadTools(entry, uploads); err != nil {
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
	client := (&entryFixture{entry: entry, server: server}).client(t, "2026-07-28", token)
	first, second := uuid.NewString(), uuid.NewString()
	args := func(taskID string, fields map[string]any) map[string]any {
		out := map[string]any{"projectId": project.ID, "taskId": taskID}
		for key, value := range fields {
			out[key] = value
		}
		return out
	}
	for _, pair := range []struct{ task, transfer string }{{live.ID, first}, {historical.ID, second}} {
		result := object(t, invitationCall(t, client, "task_attachment_put", args(pair.task, map[string]any{"action": "begin", "path": "pending.txt", "contentType": "text/plain", "transferId": pair.transfer}), false)["data"])
		if result["transferId"] != pair.transfer || result["state"] != "receiving" {
			t.Fatalf("begin: %#v", result)
		}
	}
	chunkID := uuid.NewString()
	result := object(t, invitationCall(t, client, "task_attachment_put", args(live.ID, map[string]any{"action": "chunk", "transferId": first, "chunkId": chunkID, "offset": "0", "contentBase64": "aGVsbG8="}), false)["data"])
	if result["nextOffset"] != "5" {
		t.Fatalf("chunk: %#v", result)
	}
	checkMissing := func(label string) {
		t.Helper()
		for _, action := range []string{"status", "chunk", "commit", "abort"} {
			fields := map[string]any{"action": action, "transferId": uuid.NewString()}
			switch action {
			case "chunk":
				fields["chunkId"], fields["offset"], fields["contentBase64"] = uuid.NewString(), "0", "YQ=="
			case "commit":
				fields["totalBytes"] = "0"
			}
			t.Run(label+"/"+action, func(t *testing.T) {
				out := invitationCall(t, client, "task_attachment_put", args(live.ID, fields), true)
				if fault := object(t, out["error"]); fault["code"] != "not_found" {
					t.Fatalf("missing transfer: %#v", out)
				}
			})
		}
	}
	checkMissing("live-project-missing")
	if err = tasks.Delete(ctx, owner, project.ID, historical.ID, taskcore.DeleteTask{Version: historical.Version}); err != nil {
		t.Fatal(err)
	}
	receipt, err := projectservice.NewProjects(db).Delete(ctx, owner, project.ID)
	if err != nil || !receipt.Deleted || receipt.ProjectID != project.ID {
		t.Fatalf("project delete: %+v %v", receipt, err)
	}
	for _, pair := range []struct{ task, transfer string }{{live.ID, first}, {historical.ID, second}} {
		for name, fields := range map[string]map[string]any{
			"begin":  {"action": "begin", "path": "late.txt", "contentType": "text/plain", "transferId": uuid.NewString()},
			"status": {"action": "status", "transferId": pair.transfer},
			"chunk":  {"action": "chunk", "transferId": pair.transfer, "chunkId": uuid.NewString(), "offset": "0", "contentBase64": "YQ=="},
			"commit": {"action": "commit", "transferId": pair.transfer, "totalBytes": "0"},
			"abort":  {"action": "abort", "transferId": pair.transfer},
			"inline": {"action": "inline", "path": "late.txt", "contentType": "text/plain", "contentBase64": "YQ=="},
		} {
			t.Run(pair.task+"/"+name, func(t *testing.T) {
				out := invitationCall(t, client, "task_attachment_put", args(pair.task, fields), true)
				if fault := object(t, out["error"]); fault["code"] != "not_found" {
					t.Fatalf("expected scoped not_found: %#v", out)
				}
			})
		}
	}
	checkMissing("deleted-project-missing")
	var attachments int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE project_id=$1`, project.ID).Scan(&attachments); err != nil || attachments != 0 {
		t.Fatalf("unexpected target attachment: %d %v", attachments, err)
	}

}
