package postgres

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestOfflineStorageMigrationInventoryIncludesAllAttachmentOwners(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	project, task := uuid.NewString(), uuid.NewString()
	for _, path := range []string{"Report.md", "report.md", "nested/中文.txt"} {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,$3,'text/plain',7)`, project, task, path); err != nil {
			t.Fatal(err)
		}
	}
	// Owners need not be visible or even materialized for retained metadata.
	read, err := OpenOfflineStorageMigration(ctx, db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(read.Close)
	var paths []string
	if err = read.VerifyOfflineAttachments(ctx, func(a model.Attachment) error {
		if a.ProjectID != project || a.TaskID != task || a.SizeBytes != 7 {
			t.Fatal("attachment identity changed", a)
		}
		paths = append(paths, a.Path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 3 || paths[0] != "Report.md" || paths[2] != "report.md" {
		t.Fatal(paths)
	}
	failure := errors.New("verification refused")
	if err = read.VerifyOfflineAttachments(ctx, func(model.Attachment) error { return failure }); !errors.Is(err, failure) {
		t.Fatal("callback failure lost", err)
	}
	read.Close()
	if err = read.VerifyOfflineAttachments(ctx, func(model.Attachment) error { return nil }); err == nil {
		t.Fatal("closed reader accepted")
	}
}

func TestOfflineStorageMigrationOpenRequiresCandidateSchema(t *testing.T) {
	if _, err := OpenOfflineStorageMigration(t.Context(), "postgres://bad%host/db"); err == nil {
		t.Fatal("invalid URL accepted")
	}
	db := isolatedStore(t)
	if _, err := db.Pool.Exec(t.Context(), `DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)`); err != nil {
		t.Fatal(err)
	}
	if read, err := OpenOfflineStorageMigration(t.Context(), db.Pool.Config().ConnString()); err == nil {
		read.Close()
		t.Fatal("incomplete schema accepted")
	}
}
