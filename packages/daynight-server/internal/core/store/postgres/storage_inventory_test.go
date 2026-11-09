package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBackupReaderRequiresCurrentMigrationChainAndRemainsReadOnly(t *testing.T) {
	url := scopedDatabaseURL(t)
	database, err := Open(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	readonly, err := OpenReadOnly(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	if err = readonly.Pool.QueryRow(t.Context(), "SHOW default_transaction_read_only").Scan(&mode); err != nil || mode != "on" {
		t.Fatal(mode, err)
	}
	if _, err = readonly.Pool.Exec(t.Context(), "CREATE TABLE forbidden_backup_mutation(id int)"); err == nil {
		t.Fatal("reader allowed DDL")
	}
	readonly.Close()
	_, err = database.Pool.Exec(t.Context(), "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version=(SELECT max(version) FROM schema_migrations)")
	if err != nil {
		t.Fatal(err)
	}
	if value, err := OpenReadOnly(t.Context(), url); err == nil {
		value.Close()
		t.Fatal("reader accepted changed migration checksum")
	}
	var count int
	if err = database.Pool.QueryRow(t.Context(), "SELECT count(*) FROM information_schema.tables WHERE table_name='forbidden_backup_mutation'").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}

func TestBackupInventoryRejectsOrphansAndRetainsCallbackFailure(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("integrity failed")
	calls := 0
	err := database.VerifyStorageInventory(ctx, func(value store.StorageInventory) error {
		calls++
		if value.SessionID != id || value.OwnerID != owner || value.ProjectID != "" {
			t.Fatal(value)
		}
		return sentinel
	})
	if calls != 1 || !errors.Is(err, sentinel) {
		t.Fatal(calls, err)
	}
	if _, err = database.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	calls = 0
	err = database.VerifyStorageInventory(ctx, func(store.StorageInventory) error { calls++; return nil })
	if err == nil || calls != 0 {
		t.Fatal("orphan archive omitted", calls, err)
	}
}

func TestBackupReaderFailuresRedactConnectionDetails(t *testing.T) {
	for _, url := range []string{"postgres://secret-user:secret-password@bad%host/db", "postgres://secret-user:secret-password@127.0.0.1:1/db?connect_timeout=1"} {
		_, err := OpenReadOnly(context.Background(), url)
		if err == nil || strings.Contains(err.Error(), "secret-") {
			t.Fatal("unsafe reader diagnostic", err)
		}
	}
}

func TestBackupInventoryRetainsMigrationAndSkipsReleasedStagingTombstones(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	owner, id, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution); e != nil {
		t.Fatal(e)
	}
	digest := strings.Repeat("a", 64)
	for _, released := range []bool{false, true} {
		upload, file := uuid.NewString(), uuid.NewString()
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at,storage_released) VALUES($1,$2,$3,$4,$5,'{}','{"state":"complete"}',now(),$6)`, id, upload, owner, uuid.NewString(), uuid.NewString(), released); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$2,0,1,$3,'image-staging')`, id, upload, digest); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,staging_released) VALUES($1,$2,'history',$3,1,1,'complete','history-staging',$4)`, id, file, digest, released); e != nil {
			t.Fatal(e)
		}
		if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,1,$3,'archive-staging')`, id, file, digest); e != nil {
			t.Fatal(e)
		}
	}
	migration := store.ArchiveMigration{SessionID: id, MigrationID: uuid.NewString(), SourcePath: "source", SourceHash: digest, SourceLength: 1, TargetPath: "target", TargetHash: digest, Phase: "files_durable"}
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,target_path,target_hash,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, migration.MigrationID, migration.SourcePath, migration.SourceHash, migration.SourceLength, migration.TargetPath, migration.TargetHash, migration.Phase); e != nil {
		t.Fatal(e)
	}
	calls := 0
	e := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		calls++
		if v.Migration == nil || *v.Migration != migration || len(v.Objects) != 2 {
			t.Fatal("durable source or unreleased stage omitted", v)
		}
		return nil
	})
	if e != nil || calls != 1 {
		t.Fatal(calls, e)
	}
}
