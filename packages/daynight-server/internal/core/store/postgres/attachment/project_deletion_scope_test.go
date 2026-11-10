package attachment_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestAttachmentMutationProjectLifecycle(t *testing.T) {
	db, projectID, taskID, _ := attachmentFixture(t)
	ctx := t.Context()
	run := func(id string) error {
		t.Helper()
		_, err := db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
			presence, err := scope.LockTaskPresence(ctx, projectID, taskID)
			if err != nil {
				return err
			}
			if !presence.Found {
				t.Fatal("fixture task missing")
			}
			return scope.ProjectLive(ctx, id)
		})
		return err
	}
	if err := run(projectID); err != nil {
		t.Fatalf("live project: %v", err)
	}
	if err := run(uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing project: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, projectID); err != nil {
		t.Fatal(err)
	}
	if err := run(projectID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted project: %v", err)
	}
	err := run("invalid-uuid")
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22P02" || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("database failure masked: %v", err)
	}
}

func TestAttachmentMutationUploadChunkReceipts(t *testing.T) {
	db, projectID, taskID, principal := attachmentFixture(t)
	ctx := context.Background()
	transferID, chunkID, objectID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := db.Pool.Exec(ctx, `INSERT INTO private_transfers(id,user_id,authority_kind,authority_id,direction,project_id,task_id,path,content_type,binding,data,state,created_at,updated_at,expires_at,hard_expires_at)
 VALUES($1,$2,'pat',$3,'upload',$4,$5,'x','text/plain','{}','{}','receiving',now(),now(),now()+interval '1 hour',now()+interval '2 hours')`, transferID, principal.UserID, uuid.NewString(), projectID, taskID)
	if err != nil {
		t.Fatal(err)
	}
	want := model.UploadChunk{TransferID: transferID, ChunkID: chunkID, ObjectID: objectID, Offset: 3, Size: 5, SHA256: strings.Repeat("a", 64)}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO private_upload_chunks(transfer_id,chunk_id,object_id,byte_offset,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6)`, want.TransferID, want.ChunkID, want.ObjectID, want.Offset, want.Size, want.SHA256); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		got, err := scope.UploadChunkAt(ctx, transferID, 3)
		if err != nil || got != want {
			t.Fatalf("chunk receipt: %+v %v", got, err)
		}
		_, err = scope.UploadChunkAt(ctx, transferID, 4)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing offset: %v", err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("read receipt: %+v %v", completion, err)
	}
	_, err = db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		_, err := scope.UploadChunkAt(ctx, "invalid-uuid", 0)
		return err
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22P02" || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("database error: %v", err)
	}
}
