package mcp

import (
	"context"
	"crypto/sha256"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
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

type downloadSaturationStorage struct {
	filestorage.TransferStorage
	entered chan string
	release chan struct{}
}

func (s *downloadSaturationStorage) PutTransfer(ctx context.Context, namespace filestorage.TransferNamespace, id string, input io.Reader) (filestorage.FileInfo, error) {
	select {
	case s.entered <- namespace.ID():
	case <-ctx.Done():
		return filestorage.FileInfo{}, ctx.Err()
	}
	select {
	case <-s.release:
		return s.TransferStorage.PutTransfer(ctx, namespace, id, input)
	case <-ctx.Done():
		return filestorage.FileInfo{}, ctx.Err()
	}
}

func TestDownloadSaturationPreservesTransferControl(t *testing.T) {
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "download saturation")
	otherSession := testsupport.ServicePrincipal(t, db)
	otherProject, err := projectservice.NewProjects(db).Create(t.Context(), otherSession, projectcore.CreateProject{ExpectedUserID: otherSession.UserID, Name: "upload control", RepoURL: "host:upload-control"})
	if err != nil {
		t.Fatal(err)
	}
	otherTask := testsupport.CreateTask(t, tasks, otherSession, otherProject.ID, "upload control")
	pat := func(user string) model.Principal {
		t.Helper()
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(id))
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, user, hash[:]); err != nil {
			t.Fatal(err)
		}
		return model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: id}
	}
	alice, bob := pat(session.UserID), pat(otherSession.UserID)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	blocked := &downloadSaturationStorage{TransferStorage: files, entered: make(chan string, 4), release: make(chan struct{})}
	lifecycle, err := mcptransfer.New(db, files, blocked, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	attachments := attachment.NewAttachments(db, db, files)
	if _, _, err := attachments.Put(t.Context(), alice, project.ID, task.ID, "file", "text/plain", strings.NewReader("snapshot")); err != nil {
		t.Fatal(err)
	}
	fixture := newEntryFixture(t)
	fixture.entry.auth = downloadSaturationAuth{"alice": alice, "bob": bob}
	if err := RegisterDownloadTool(fixture.entry, mcpdownload.New(attachments, lifecycle, blocked)); err != nil {
		t.Fatal(err)
	}
	if err := RegisterUploadTools(fixture.entry, mcptransfer.NewUploads(lifecycle, blocked, attachments)); err != nil {
		t.Fatal(err)
	}
	downloadClient := fixture.client(t, "2026-07-28", "alice")
	uploadClient := fixture.client(t, "2026-07-28", "bob")
	uploadID := uuid.NewString()
	begin := map[string]any{"projectId": otherProject.ID, "taskId": otherTask.ID, "action": "begin", "path": "upload", "contentType": "text/plain", "transferId": uploadID}
	if data := object(t, invitationCall(t, uploadClient, "task_attachment_put", begin, false)["data"]); data["state"] != "receiving" {
		t.Fatalf("begin: %#v", data)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	released := false
	defer func() {
		if !released {
			close(blocked.release)
		}
	}()
	ids := make([]string, 4)
	seenStripes := make(map[byte]bool)
	type result struct {
		id     string
		failed bool
		err    error
	}
	results := make(chan result, 4)
	for i := range ids {
		for {
			candidate := uuid.NewString()
			stripe := sha256.Sum256([]byte(candidate))[0]
			if !seenStripes[stripe] {
				seenStripes[stripe] = true
				ids[i] = candidate
				break
			}
		}
		id := ids[i]
		go func() {
			args := map[string]any{"projectId": project.ID, "taskId": task.ID, "action": "open", "path": "file", "transferId": id}
			out, err := downloadClient.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_read", Arguments: args})
			results <- result{id: id, failed: out != nil && out.IsError, err: err}
		}()
	}
	for range ids {
		select {
		case <-blocked.entered:
		case <-ctx.Done():
			t.Fatal("downloads did not reach private I/O")
		}
	}
	newID := uuid.NewString()
	newOpen := map[string]any{"projectId": project.ID, "taskId": task.ID, "action": "open", "path": "file", "transferId": newID}
	busy := object(t, invitationCall(t, downloadClient, "task_attachment_read", newOpen, true)["error"])
	if busy["code"] != "resource_busy" {
		t.Fatalf("new open: %#v", busy)
	}
	var created bool
	if err := db.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM private_transfers WHERE id=$1)`, newID).Scan(&created); err != nil || created {
		t.Fatalf("refused open registered a transfer: %v, %v", created, err)
	}
	repeat := map[string]any{"projectId": project.ID, "taskId": task.ID, "action": "open", "path": "file", "transferId": ids[0]}
	status := object(t, invitationCall(t, downloadClient, "task_attachment_read", repeat, false)["data"])
	if status["state"] != "preparing" || status["transferId"] != ids[0] {
		t.Fatalf("repeat open: %#v", status)
	}
	for _, action := range []string{"status", "abort"} {
		args := map[string]any{"projectId": otherProject.ID, "taskId": otherTask.ID, "action": action, "transferId": uploadID}
		data := object(t, invitationCall(t, uploadClient, "task_attachment_put", args, false)["data"])
		if action == "status" && data["state"] != "receiving" {
			t.Fatalf("upload status: %#v", data)
		}
		if action == "abort" && data["state"] != "cleanup_pending" {
			t.Fatalf("upload abort: %#v", data)
		}
	}
	closeInput := map[string]any{"projectId": project.ID, "taskId": task.ID, "action": "close", "transferId": ids[0]}
	closed := object(t, invitationCall(t, downloadClient, "task_attachment_read", closeInput, false)["data"])
	if closed["state"] != "cleanup_pending" {
		t.Fatalf("download close: %#v", closed)
	}
	close(blocked.release)
	released = true
	for range ids {
		select {
		case out := <-results:
			if out.id != ids[0] && (out.err != nil || out.failed) {
				t.Fatalf("open %s failed: %+v", out.id, out)
			}
		case <-ctx.Done():
			t.Fatal("downloads did not finish")
		}
	}
}
