package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func migrationRecordFixture(t *testing.T) (string, string, core.Task, AttachmentMigrationSummary) {
	t.Helper()
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Operation records")
	root := t.TempDir()
	name := filepath.Join(root, attachmentBucket, task.ID, "file.bin")
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte{0, 255, 1}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := database.PutAttachment(context.Background(), core.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: "file.bin", ContentType: "application/octet-stream", SizeBytes: 3}); err != nil {
		t.Fatal(err)
	}
	plan, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "plan", "", slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return databaseURL, root, task, plan
}

func mutateMigrationRecord(t *testing.T, file string, change func(map[string]any)) {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	change(value)
	data, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentMigrationRejectsChangedOperationRecords(t *testing.T) {
	for _, test := range []struct {
		name   string
		record string
		change func(map[string]any)
	}{
		{"unknown manifest fields", "manifest.json", func(record map[string]any) { record["unknown"] = true }},
		{"manifest operation mismatch", "manifest.json", func(record map[string]any) { record["operationId"] = "00000000-0000-0000-0000-000000000000" }},
		{"manifest version mismatch", "manifest.json", func(record map[string]any) { record["version"] = 2 }},
		{"stage checksum mismatch", "state.json", func(record map[string]any) { record["manifestSha256"] = strings.Repeat("0", 64) }},
		{"stage operation mismatch", "state.json", func(record map[string]any) { record["operationId"] = "00000000-0000-0000-0000-000000000000" }},
		{"stage version mismatch", "state.json", func(record map[string]any) { record["version"] = 2 }},
		{"unknown stage", "state.json", func(record map[string]any) { record["phase"] = "unknown" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			databaseURL, root, task, plan := migrationRecordFixture(t)
			mutateMigrationRecord(t, filepath.Join(root, attachmentMigrationPrefix+plan.OperationID, test.record), test.change)
			_, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "apply", plan.OperationID, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			var failure *AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != "invalid_manifest" {
				t.Fatalf("changed operation was not rejected: %v", err)
			}
			actual, err := os.ReadFile(filepath.Join(root, attachmentBucket, task.ID, "file.bin"))
			if err != nil || !bytes.Equal(actual, []byte{0, 255, 1}) {
				t.Fatalf("invalid records changed source bytes: %v, %v", actual, err)
			}
		})
	}
}

func TestAttachmentMigrationRecoversPlanBeforeStagePublication(t *testing.T) {
	databaseURL, root, task, plan := migrationRecordFixture(t)
	if err := os.Remove(filepath.Join(root, attachmentMigrationPrefix+plan.OperationID, "state.json")); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	if _, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "plan", "", logger); err == nil {
		t.Fatal("a plan with an unpublished stage was ignored")
	}
	if _, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "apply", plan.OperationID, logger); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("apply did not preserve the missing stage diagnostic: %v", err)
	}
	result, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "resume", plan.OperationID, logger)
	if err != nil || result.Phase != "complete" {
		t.Fatalf("explicit resume did not reconcile the fully persisted plan: %+v %v", result, err)
	}
	actual, err := os.ReadFile(filepath.Join(root, attachmentBucket, task.ProjectID, task.ID[:2], task.ID, "file.bin"))
	if err != nil || !bytes.Equal(actual, []byte{0, 255, 1}) {
		t.Fatalf("recovered plan changed content: %v, %v", actual, err)
	}
}

func TestAttachmentMigrationRejectsUnsafeOrIncompleteReceipts(t *testing.T) {
	for _, change := range []string{"missing", "unknown field", "different count", "trailing JSON", "symlink"} {
		t.Run(change, func(t *testing.T) {
			databaseURL, root, _, plan := migrationRecordFixture(t)
			logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
			completed, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "apply", plan.OperationID, logger)
			if err != nil {
				t.Fatal(err)
			}
			receipt := filepath.Join(root, *completed.ReceiptPath)
			switch change {
			case "missing":
				err = os.Remove(receipt)
			case "unknown field":
				mutateMigrationRecord(t, receipt, func(record map[string]any) { record["unknown"] = true })
			case "different count":
				mutateMigrationRecord(t, receipt, func(record map[string]any) { record["fileCount"] = 9 })
			case "trailing JSON":
				file, openErr := os.OpenFile(receipt, os.O_APPEND|os.O_WRONLY, 0)
				if openErr != nil {
					t.Fatal(openErr)
				}
				_, writeErr := io.WriteString(file, "{}")
				err = errors.Join(writeErr, file.Close())
			case "symlink":
				if err = os.Rename(receipt, receipt+".original"); err == nil {
					err = os.Symlink("receipt.json.original", receipt)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "resume", plan.OperationID, logger); err == nil {
				t.Fatal("completed operation trusted an invalid receipt")
			}
		})
	}
}

func TestAttachmentMigrationRejectsUnsafeOperationPaths(t *testing.T) {
	for _, name := range []string{"manifest directory", "target symlink", "manifest trailing JSON"} {
		t.Run(name, func(t *testing.T) {
			databaseURL, root, task, plan := migrationRecordFixture(t)
			directory := filepath.Join(root, attachmentMigrationPrefix+plan.OperationID)
			manifest := filepath.Join(directory, "manifest.json")
			switch name {
			case "manifest directory":
				if err := os.Remove(manifest); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(manifest, 0o700); err != nil {
					t.Fatal(err)
				}
			case "target symlink":
				if err := os.Symlink("../"+attachmentBucket, filepath.Join(directory, "target")); err != nil {
					t.Fatal(err)
				}
			case "manifest trailing JSON":
				file, err := os.OpenFile(manifest, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				_, writeErr := io.WriteString(file, " true")
				if err := errors.Join(writeErr, file.Close()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "apply", plan.OperationID, slog.New(slog.NewJSONHandler(io.Discard, nil))); err == nil {
				t.Fatal("unsafe operation entry was accepted")
			}
			if _, err := os.Stat(filepath.Join(root, attachmentBucket, task.ID, "file.bin")); err != nil {
				t.Fatal("unsafe operation entry changed the old content")
			}
		})
	}
}

func TestAttachmentMigrationCommandAndRootFailures(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for _, input := range [][2]string{{"unknown", ""}, {"plan", "00000000-0000-0000-0000-000000000000"}, {"apply", "bad"}, {"resume", ""}} {
		_, err := MigrateAttachmentLayout(context.Background(), "", "", input[0], input[1], logger)
		var failure *AttachmentMigrationError
		if !errors.As(err, &failure) || failure.Category != "invalid_input" {
			t.Fatalf("invalid action or ID was not rejected before connecting: %v", err)
		}
	}
	_, _, databaseURL, _ := projectService(t)
	root := filepath.Join(t.TempDir(), "missing")
	_, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "plan", "", logger)
	if !errors.Is(err, fs.ErrNotExist) || strings.Contains(err.Error(), root) {
		t.Fatalf("missing root cause was hidden or leaked a host path: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := MigrateAttachmentLayout(ctx, databaseURL, t.TempDir(), "plan", "", logger); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled connection lost its cause: %v", err)
	}
}
