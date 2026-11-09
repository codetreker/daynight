package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBackupInventoryIncludesReadyIdentityAndBothOriginalRepresentations(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); e != nil {
		t.Fatal(e)
	}
	hash, length, mime := strings.Repeat("a", 64), "1", "text/plain"
	blob := uuid.NewString()
	inlineID, blobID := uuid.NewString(), uuid.NewString()
	for _, resourceID := range []string{inlineID, blobID} {
		descriptor, e := json.Marshal(sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime})
		if e != nil {
			t.Fatal(e)
		}
		if resourceID == inlineID {
			_, e = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,$3,$4)`, id, resourceID, descriptor, []byte("x"))
		} else {
			_, e = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$4,'original/blob')`, id, resourceID, descriptor, blob)
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness) VALUES($1,'ready',$2,1,'original/manifest',3,'complete')`, id, hash); e != nil {
		t.Fatal(e)
	}
	calls := 0
	e := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		calls++
		if v.SessionID != id || v.OwnerID != owner || v.Archive == nil || v.Archive.SchemaVersion != 3 || v.Archive.Path != "original/manifest" || v.Archive.SHA256 != hash || v.Archive.ByteLength != 1 || len(v.Resources) != 2 || len(v.InlineResources) != 1 || v.InlineResources[0].Resource.ResourceID != inlineID || string(v.InlineResources[0].Content) != "x" {
			t.Fatal("restored inventory lost original bytes or ready identity", v)
		}
		found := false
		for _, r := range v.Resources {
			if r.Resource.ResourceID == blobID && r.BlobID == blob && r.BlobPath == "original/blob" {
				found = true
			}
		}
		if !found {
			t.Fatal("stored immutable blob identity omitted")
		}
		return nil
	})
	if e != nil || calls != 1 {
		t.Fatal(calls, e)
	}
}

func TestBackupInventoryRejectsCorruptRestoredMetadataAndMissingRelations(t *testing.T) {
	for _, kind := range []string{"descriptor", "ready-identity", "missing-resources", "missing-chunks", "missing-archives", "canceled"} {
		t.Run(kind, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := t.Context()
			owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
			if _, e := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); e != nil {
				t.Fatal(e)
			}
			var e error
			switch kind {
			case "descriptor":
				_, e = database.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, id, uuid.NewString())
			case "ready-identity":
				if _, e = database.Pool.Exec(ctx, `ALTER TABLE session_archives DROP CONSTRAINT session_archive_body`); e == nil {
					_, e = database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state) VALUES($1,'ready')`, id)
				}
			case "missing-resources":
				_, e = database.Pool.Exec(ctx, `ALTER TABLE session_resources RENAME TO missing_session_resources`)
			case "missing-chunks":
				_, e = database.Pool.Exec(ctx, `ALTER TABLE session_image_chunks RENAME TO missing_session_image_chunks`)
			case "missing-archives":
				_, e = database.Pool.Exec(ctx, `ALTER TABLE session_archives RENAME TO missing_session_archives`)
			case "canceled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if e != nil {
				t.Fatal(e)
			}
			calls := 0
			e = database.VerifyStorageInventory(ctx, func(store.StorageInventory) error { calls++; return nil })
			if e == nil || calls != 0 {
				t.Fatal("invalid restored cut reached the closure verifier", kind, calls, e)
			}
			if kind == "canceled" && !errors.Is(e, context.Canceled) {
				t.Fatal("inventory cancellation cause replaced", e)
			}
		})
	}
}
