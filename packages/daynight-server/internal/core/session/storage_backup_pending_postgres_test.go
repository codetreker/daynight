package session

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

// The inventory query and the read-only verifier must agree about the same
// first-chunk intent after an interrupted publication.
func TestStorageBackupPostgresPendingFirstChunk(t *testing.T) {
	if os.Getenv("DAYNIGHT_TEST_DATABASE_URL") == "" {
		t.Skip("requires isolated PostgreSQL")
	}
	db := testutil.OpenStore(t, postgres.Open)
	_, actor, _ := testutil.AuthRecords(t, db)
	ctx := t.Context()
	id, uploadID, imageID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}
	namespace, err := sessionresource.NewNamespace("", actor.UserID, id)
	if err != nil {
		t.Fatal(err)
	}
	path, err := namespace.ChunkPath(uploadID, 0)
	if err != nil {
		t.Fatal(err)
	}
	original := []byte("original")
	expires := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	spec := sp.ImageUploadSpec{UploadID: uploadID, ImageID: imageID, Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor.UserID, Fence: fence}, Name: "original.png", MediaType: "image/png", ByteLength: "8", SHA256: archiveDigest(original)}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: spec, ExpiresAt: expires, Receipt: sp.ImageUploadReceipt{UploadID: uploadID, ImageID: imageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}, ExpiresAt: expires.Format(time.RFC3339Nano)}}
	intent := store.SessionUploadChunk{SessionID: id, UploadID: uploadID, Offset: 0, ByteLength: int64(len(original)), SHA256: spec.SHA256, Path: path}
	_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if e := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: fence.TestExecutionID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Lifecycle: "active"}, ParentCredentialID: actor.CredentialID}); e != nil {
			return e
		}
		media := dao.(store.SessionResourceDAO)
		if e := media.SaveSessionUpload(ctx, upload); e != nil {
			return e
		}
		return media.InsertSessionUploadChunk(ctx, intent)
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := files.Close(); e != nil {
			t.Error(e)
		}
	})
	verify := func() error {
		t.Helper()
		reader, e := local.OpenReadOnly(root)
		if e != nil {
			return e
		}
		defer reader.Close()
		return db.VerifyStorageInventory(ctx, func(inventory store.StorageInventory) error {
			return VerifyStorageBackup(ctx, reader, inventory)
		})
	}
	if err := verify(); err != nil {
		t.Fatalf("missing unconfirmed first chunk rejected: %v", err)
	}
	if _, err := files.Put(ctx, sessionresource.Bucket, path, bytes.NewReader([]byte("changed!"))); err != nil {
		t.Fatal(err)
	}
	if err := verify(); err == nil {
		t.Fatal("existing unconfirmed chunk with different bytes was accepted")
	}
	if _, err := files.Put(ctx, sessionresource.Bucket, path, bytes.NewReader(original)); err != nil {
		t.Fatal(err)
	}
	if err := verify(); err != nil {
		t.Fatalf("existing matching unconfirmed chunk rejected: %v", err)
	}
	upload.Receipt.AcceptedOffset = "8"
	_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionUpload(ctx, upload)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := files.Delete(ctx, sessionresource.Bucket, path); err != nil {
		t.Fatal(err)
	}
	if err := verify(); err == nil {
		t.Fatal("missing confirmed first chunk was accepted")
	}
	for _, state := range []string{"failed", "released", "expired"} {
		t.Run(state, func(t *testing.T) {
			upload.Receipt.State, upload.Receipt.AcceptedOffset = state, "0"
			upload.Receipt.Error = nil
			if state != "released" {
				upload.Receipt.Error = &sp.ImageError{Code: "storage_unavailable", Message: "Original upload failed."}
			}
			if _, e := db.WriteSession(ctx, func(scope store.SessionScope) error {
				return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionUpload(ctx, upload)
			}); e != nil {
				t.Fatal(e)
			}
			if e := verify(); e != nil {
				t.Fatalf("missing unconfirmed %s first chunk rejected: %v", state, e)
			}
		})
	}
	for _, state := range []string{"verifying", "complete"} {
		t.Run(state, func(t *testing.T) {
			upload.Receipt.State, upload.Receipt.AcceptedOffset = state, "0"
			upload.Receipt.Error = nil
			if _, e := db.WriteSession(ctx, func(scope store.SessionScope) error {
				return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionUpload(ctx, upload)
			}); e != nil {
				t.Fatal(e)
			}
			if e := verify(); e == nil {
				t.Fatalf("missing %s original was accepted", state)
			}
		})
	}
}
