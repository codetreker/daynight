package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type uploadCleanupStorage struct{ filestorage.Storage }
type uploadCleanupCloser struct{ io.Closer }

func (c uploadCleanupCloser) Close() error {
	return errors.Join(c.Closer.Close(), errors.New("injected private gate close failure"))
}

func (s uploadCleanupStorage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	gate, err := s.Storage.AcquireGate(ctx, domain, key)
	if err != nil || domain != filestorage.PrivateGate {
		return gate, err
	}
	return uploadCleanupCloser{gate}, nil
}

func TestUploadChunkReceiptSurvivesCleanupFailureInMCP(t *testing.T) {
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "upload receipt")
	credential := uuid.NewString()
	hash := sha256.Sum256([]byte(credential))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, credential, session.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	lifecycle, err := mcptransfer.New(db, uploadCleanupStorage{files}, files, 1<<30, 0)
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
	f := newEntryFixture(t)
	f.entry.auth = downloadSaturationAuth{"alice": {Kind: model.PATCredential, UserID: session.UserID, CredentialID: credential}}
	if err := RegisterUploadTools(f.entry, mcptransfer.NewUploads(lifecycle, files, attachmentservice.NewAttachments(db, db, files))); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	transferID, chunkID := uuid.NewString(), uuid.NewString()
	args := func(action string) map[string]any {
		return map[string]any{"projectId": project.ID, "taskId": task.ID, "action": action, "transferId": transferID}
	}
	begin := args("begin")
	begin["path"], begin["contentType"] = "file", "text/plain"
	invitationCall(t, client, "task_attachment_put", begin, false)
	chunk := args("chunk")
	chunk["chunkId"], chunk["offset"], chunk["contentBase64"] = chunkID, "0", "YQ=="
	for _, receipt := range []string{"accepted", "already_accepted"} {
		fault := object(t, invitationCall(t, client, "task_attachment_put", chunk, true)["error"])
		refs := object(t, fault["refs"])
		digest := sha256.Sum256([]byte("a"))
		if fault["code"] != "internal_error" || fault["writeOutcome"] != nil || refs["transferId"] != transferID || refs["chunkId"] != chunkID || refs["receipt"] != receipt || refs["offset"] != "0" || refs["acceptedBytes"] != "1" || refs["nextOffset"] != "1" || refs["sha256"] != hex.EncodeToString(digest[:]) || refs["expiresAt"] == nil {
			t.Fatalf("chunk receipt lost or target outcome invented: %#v", fault)
		}
	}
	status := object(t, invitationCall(t, client, "task_attachment_put", args("status"), false)["data"])
	if status["nextOffset"] != "1" {
		t.Fatalf("durable offset: %#v", status)
	}
}
