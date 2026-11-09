package migration_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment/migration"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

func TestAttachmentMigrationCommandAndRootFailures(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for _, input := range [][2]string{{"unknown", ""}, {"plan", "00000000-0000-0000-0000-000000000000"}, {"apply", "bad"}, {"resume", ""}} {
		_, err := runAttachmentMigration(context.Background(), "", "", input[0], input[1], logger)
		var failure *migration.AttachmentMigrationError
		if !errors.As(err, &failure) || failure.Category != "invalid_input" {
			t.Fatalf("invalid action or ID was not rejected before connecting: %v", err)
		}
	}
	_, _, databaseURL, _ := testsupport.ProjectService(t)
	root := filepath.Join(t.TempDir(), "missing")
	_, err := runAttachmentMigration(context.Background(), databaseURL, root, "plan", "", logger)
	if !errors.Is(err, fs.ErrNotExist) || strings.Contains(err.Error(), root) {
		t.Fatalf("missing root cause was hidden or leaked a host path: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runAttachmentMigration(ctx, databaseURL, t.TempDir(), "plan", "", logger); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled connection lost its cause: %v", err)
	}
}

func TestAttachmentMigrationRejectsUnsupportedDatabaseShapeWithoutMovingFiles(t *testing.T) {
	for _, sql := range []string{
		`DROP TABLE task_attachments`,
		`ALTER TABLE projects RENAME COLUMN id TO missing_id`,
		`ALTER TABLE tasks RENAME COLUMN project_id TO missing_project_id`,
		`ALTER TABLE task_attachments RENAME COLUMN path TO missing_path`,
	} {
		t.Run(sql, func(t *testing.T) {
			_, database, databaseURL, _ := testsupport.ProjectService(t)
			if _, err := database.Pool.Exec(context.Background(), sql); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			name := filepath.Join(root, attachmentcore.Bucket, "00000000-0000-0000-0000-000000000001", "preserved")
			if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(name, []byte("preserved"), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := runAttachmentMigration(context.Background(), databaseURL, root, "plan", "", slog.New(slog.NewJSONHandler(io.Discard, nil)))
			var failure *migration.AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != "database" || errors.Unwrap(err) == nil {
				t.Fatalf("unsupported source schema did not retain its database error: %v", err)
			}
			if actual, err := os.ReadFile(name); err != nil || string(actual) != "preserved" {
				t.Fatalf("failed database inventory changed legacy files: %q %v", actual, err)
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 1 || entries[0].Name() != attachmentcore.Bucket {
				t.Fatalf("failed metadata inventory created an operation: %v %v", entries, err)
			}
		})
	}
}
