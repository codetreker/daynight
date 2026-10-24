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

func TestAttachmentMigrationRejectsContradictoryPersistedInventories(t *testing.T) {
	firstTask := func(record map[string]any) map[string]any { return record["tasks"].([]any)[0].(map[string]any) }
	firstFile := func(record map[string]any) map[string]any {
		return firstTask(record)["entries"].([]any)[1].(map[string]any)
	}
	for _, test := range []struct {
		name     string
		category string
		change   func(map[string]any)
	}{
		{"invalid task identity", "invalid_manifest", func(record map[string]any) { firstTask(record)["taskId"] = "invalid" }},
		{"duplicate task roots", "invalid_manifest", func(record map[string]any) { record["tasks"] = append(record["tasks"].([]any), firstTask(record)) }},
		{"path outside task root", "invalid_manifest", func(record map[string]any) { firstFile(record)["path"] = "../outside" }},
		{"duplicate file entries", "invalid_manifest", func(record map[string]any) {
			task := firstTask(record)
			task["entries"] = append(task["entries"].([]any), firstFile(record))
		}},
		{"unsupported entry kind", "invalid_manifest", func(record map[string]any) { firstFile(record)["kind"] = "symlink" }},
		{"negative entry size", "invalid_manifest", func(record map[string]any) { firstFile(record)["size"] = -1 }},
		{"invalid content checksum", "invalid_manifest", func(record map[string]any) { firstFile(record)["sha256"] = "invalid" }},
		{"missing existing task root", "invalid_manifest", func(record map[string]any) {
			task := firstTask(record)
			task["entries"] = task["entries"].([]any)[1:]
		}},
		{"entries under absent root", "invalid_manifest", func(record map[string]any) { firstTask(record)["exists"] = false }},
		{"missing owner inventory", "invalid_manifest", func(record map[string]any) { record["owners"] = []any{} }},
		{"contradictory owner inventory", "invalid_manifest", func(record map[string]any) {
			record["owners"].([]any)[0].(map[string]any)["projectId"] = "00000000-0000-0000-0000-000000000000"
		}},
		{"contradictory attachment owner", "ownership", func(record map[string]any) {
			record["attachments"].([]any)[0].(map[string]any)["projectId"] = "00000000-0000-0000-0000-000000000000"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			databaseURL, root, task, plan := migrationRecordFixture(t)
			mutateMigrationRecord(t, filepath.Join(root, attachmentMigrationPrefix+plan.OperationID, "manifest.json"), test.change)
			_, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "apply", plan.OperationID, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			var failure *AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != test.category {
				t.Fatalf("contradictory inventory did not fail safely: %v", err)
			}
			if actual, err := os.ReadFile(filepath.Join(root, attachmentBucket, task.ID, "file.bin")); err != nil || !bytes.Equal(actual, []byte{0, 255, 1}) {
				t.Fatalf("invalid inventory changed its source: %v %v", actual, err)
			}
			if _, err := os.Stat(filepath.Join(root, attachmentMigrationPrefix+plan.OperationID, "source")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("invalid inventory moved its source bucket: %v", err)
			}
		})
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
			_, database, databaseURL, _ := projectService(t)
			if _, err := database.Pool.Exec(context.Background(), sql); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			name := filepath.Join(root, attachmentBucket, "00000000-0000-0000-0000-000000000001", "preserved")
			if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(name, []byte("preserved"), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := MigrateAttachmentLayout(context.Background(), databaseURL, root, "plan", "", slog.New(slog.NewJSONHandler(io.Discard, nil)))
			var failure *AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != "database" || errors.Unwrap(err) == nil {
				t.Fatalf("unsupported source schema did not retain its database error: %v", err)
			}
			if actual, err := os.ReadFile(name); err != nil || string(actual) != "preserved" {
				t.Fatalf("failed database inventory changed legacy files: %q %v", actual, err)
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 1 || entries[0].Name() != attachmentBucket {
				t.Fatalf("failed metadata inventory created an operation: %v %v", entries, err)
			}
		})
	}
}

func TestAttachmentMigrationFilesystemFailuresPreserveExistingContent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "source"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "source", "preserved"), []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "occupied"), []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	opened, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if err := opened.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	m := &attachmentMigration{root: opened, phase: "placing"}
	assertFailure := func(err error, category string, cause error) {
		t.Helper()
		var failure *AttachmentMigrationError
		if !errors.As(err, &failure) || failure.Category != category || cause != nil && !errors.Is(err, cause) || strings.Contains(err.Error(), root) {
			t.Fatalf("filesystem failure lost its category/cause or exposed a host path: %v", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = m.readDirectory(ctx, ".")
	assertFailure(err, "canceled", context.Canceled)
	_, err = m.readDirectory(context.Background(), "missing")
	assertFailure(err, "filesystem", fs.ErrNotExist)
	_, err = m.readDirectory(context.Background(), "occupied")
	assertFailure(err, "filesystem", nil)
	assertFailure(m.syncDirectory("missing"), "filesystem", fs.ErrNotExist)
	assertFailure(m.makeParents("occupied/child"), "unsafe_entry", nil)
	assertFailure(m.rename(context.Background(), "source", "occupied"), "target_conflict", nil)
	assertFailure(m.rename(context.Background(), "missing", "new-target"), "filesystem", fs.ErrNotExist)
	_, err = m.writeJSON("occupied", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "operation_conflict", nil)
	_, err = m.writeJSON("missing/record.json", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "filesystem", fs.ErrNotExist)
	if err := opened.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	assertFailure(m.rename(context.Background(), "source", "new-target"), "filesystem", nil)
	_, err = m.writeJSON("record.json", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "filesystem", nil)
	for name, expected := range map[string]string{"source/preserved": "source", "occupied": "target"} {
		if actual, err := os.ReadFile(filepath.Join(root, name)); err != nil || string(actual) != expected {
			t.Fatalf("failed filesystem operation modified %s: %q %v", name, actual, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "new-target")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("failed rename created a target: %v", err)
	}
}

func TestAttachmentMigrationCanceledHashReaderDoesNotConsumeContent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	content := strings.NewReader("preserved content")
	reader := attachmentMigrationReader{ctx: ctx, reader: content}
	buffer := []byte("unchanged")
	n, err := reader.Read(buffer)
	if n != 0 || !errors.Is(err, context.Canceled) || string(buffer) != "unchanged" || content.Len() != len("preserved content") {
		t.Fatalf("canceled verification consumed content: n=%d err=%v buffer=%q remaining=%d", n, err, buffer, content.Len())
	}
}
