package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type attachmentMigrationIntegrationOwner struct {
	projectID string
	taskID    string
}

type attachmentMigrationIntegrationFixture struct {
	database    *store.Store
	databaseURL string
	root        string
	projects    []string
	owners      []attachmentMigrationIntegrationOwner
	files       map[string][]byte
}

func attachmentMigrationIntegrationSetup(t *testing.T) *attachmentMigrationIntegrationFixture {
	t.Helper()
	_, database, project, databaseURL, principal := taskService(t)
	other, err := NewProjects(database).Create(t.Context(), principal, CreateProject{Name: "Migration secondary", RepoURL: "host:migration-secondary"})
	if err != nil {
		t.Fatal(err)
	}
	return &attachmentMigrationIntegrationFixture{database: database, databaseURL: databaseURL,
		root: t.TempDir(), projects: []string{project.ID, other.ID}, files: map[string][]byte{}}
}

func (fixture *attachmentMigrationIntegrationFixture) addTask(t *testing.T, projectID, taskID string) attachmentMigrationIntegrationOwner {
	t.Helper()
	if _, err := fixture.database.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title) VALUES ($1,$2,'Migration fixture')`, taskID, projectID); err != nil {
		t.Fatal(err)
	}
	owner := attachmentMigrationIntegrationOwner{projectID: projectID, taskID: taskID}
	fixture.owners = append(fixture.owners, owner)
	return owner
}

func (fixture *attachmentMigrationIntegrationFixture) writeLegacy(t *testing.T, owner attachmentMigrationIntegrationOwner, path string, content []byte, registered bool) {
	t.Helper()
	name := filepath.Join(fixture.root, "task-attachments", owner.taskID, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, content, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.files[owner.taskID+"/"+path] = bytes.Clone(content)
	if registered {
		if _, _, err := fixture.database.PutAttachment(t.Context(), core.Attachment{ProjectID: owner.projectID,
			TaskID: owner.taskID, Path: path, ContentType: "application/octet-stream", SizeBytes: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
	}
}

func (fixture *attachmentMigrationIntegrationFixture) seed(t *testing.T) {
	t.Helper()
	first := fixture.addTask(t, fixture.projects[0], "ab000000-0000-4000-8000-000000000001")
	second := fixture.addTask(t, fixture.projects[0], "ab000000-0000-4000-8000-000000000002")
	third := fixture.addTask(t, fixture.projects[1], "cd000000-0000-4000-8000-000000000003")
	collision := fixture.addTask(t, fixture.projects[1], fixture.projects[0])
	empty := fixture.addTask(t, fixture.projects[1], "ef000000-0000-4000-8000-000000000004")
	fixture.addTask(t, fixture.projects[1], "aa000000-0000-4000-8000-000000000005")
	fixture.writeLegacy(t, first, "文档 space/binary%_?#.bin", []byte{0, 255, 128, 13, 10}, true)
	fixture.writeLegacy(t, second, "empty.txt", []byte{}, true)
	fixture.writeLegacy(t, third, "site/index.html", []byte("<p>nested content</p>\n"), true)
	fixture.writeLegacy(t, collision, "docs/nested.md", []byte("# UUID collision\n"), true)
	fixture.writeLegacy(t, first, "unregistered.bin", []byte("preserved without inventing metadata"), false)
	for _, directory := range []string{filepath.Join(second.taskID, "empty-dir", "nested"), empty.taskID} {
		if err := os.MkdirAll(filepath.Join(fixture.root, "task-attachments", directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.database.Pool.Exec(t.Context(), `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3)`,
		fixture.projects[0], first.taskID, second.taskID); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(fixture.root, "another-bucket"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.root, "another-bucket", "untouched.bin"), []byte("other bucket"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (fixture *attachmentMigrationIntegrationFixture) run(t *testing.T, action, operationID string) (AttachmentMigrationSummary, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	return MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, action, operationID,
		slog.New(slog.NewJSONHandler(io.Discard, nil)))
}

func (fixture *attachmentMigrationIntegrationFixture) requireRun(t *testing.T, action, operationID string) AttachmentMigrationSummary {
	t.Helper()
	summary, err := fixture.run(t, action, operationID)
	if err != nil {
		t.Fatalf("%s: %v", action, err)
	}
	return summary
}

func (fixture *attachmentMigrationIntegrationFixture) databaseSnapshot(t *testing.T) map[string]string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	result := map[string]string{}
	for _, table := range []string{"projects", "tasks", "task_dependencies", "task_attachments", "schema_migrations"} {
		query := fmt.Sprintf(`SELECT COALESCE(jsonb_agg(data ORDER BY data::text COLLATE "C"),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) AS data FROM %s t) rows`, table)
		var data string
		if err := fixture.database.Pool.QueryRow(ctx, query).Scan(&data); err != nil {
			t.Fatal(err)
		}
		result[table] = data
	}
	return result
}

type attachmentMigrationIntegrationEntry struct {
	mode fs.FileMode
	size int64
	hash string
	link string
}

func attachmentMigrationIntegrationTree(t *testing.T, directory string) map[string]attachmentMigrationIntegrationEntry {
	t.Helper()
	result := map[string]attachmentMigrationIntegrationEntry{}
	err := filepath.WalkDir(directory, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(directory, name)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		value := attachmentMigrationIntegrationEntry{mode: info.Mode().Type()}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(data)
			value.size, value.hash = int64(len(data)), hex.EncodeToString(digest[:])
		} else if info.Mode()&os.ModeSymlink != 0 {
			value.link, err = os.Readlink(name)
			if err != nil {
				return err
			}
		}
		result[filepath.ToSlash(relative)] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (fixture *attachmentMigrationIntegrationFixture) assertPublished(t *testing.T, legacy map[string]attachmentMigrationIntegrationEntry) {
	t.Helper()
	expected := map[string]attachmentMigrationIntegrationEntry{".": {mode: fs.ModeDir}}
	for _, owner := range fixture.owners {
		for relative, entry := range legacy {
			if relative != owner.taskID && !strings.HasPrefix(relative, owner.taskID+"/") {
				continue
			}
			prefix := owner.projectID + "/" + owner.taskID[:2]
			expected[owner.projectID] = attachmentMigrationIntegrationEntry{mode: fs.ModeDir}
			expected[prefix] = attachmentMigrationIntegrationEntry{mode: fs.ModeDir}
			expected[prefix+"/"+relative] = entry
		}
	}
	actual := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("published tree differs:\nactual %#v\nexpected %#v", actual, expected)
	}
	for _, owner := range fixture.owners {
		for name, want := range fixture.files {
			if !strings.HasPrefix(name, owner.taskID+"/") {
				continue
			}
			actual, err := os.ReadFile(filepath.Join(fixture.root, "task-attachments", owner.projectID, owner.taskID[:2], filepath.FromSlash(name)))
			if err != nil || !bytes.Equal(actual, want) {
				t.Fatalf("published bytes %s: %v, %v", name, actual, err)
			}
		}
	}
}

func attachmentMigrationIntegrationError(t *testing.T, err error, category string) *AttachmentMigrationError {
	t.Helper()
	var migration *AttachmentMigrationError
	if !errors.As(err, &migration) || migration.Category != category || migration.Diagnostic == "" {
		t.Fatalf("expected migration error %s, got %#v", category, err)
	}
	return migration
}

type attachmentMigrationIntegrationEvent struct {
	OperationID string `json:"operationId"`
	Phase       string `json:"phase"`
	Step        string `json:"step"`
	TaskID      string `json:"taskId"`
}

type attachmentMigrationIntegrationLog struct {
	t      *testing.T
	notify func(attachmentMigrationIntegrationEvent)
}

func (log attachmentMigrationIntegrationLog) Write(data []byte) (int, error) {
	var event attachmentMigrationIntegrationEvent
	if err := json.Unmarshal(data, &event); err != nil {
		log.t.Fatalf("migration emitted invalid JSON: %v", err)
	}
	log.notify(event)
	return len(data), nil
}

func attachmentMigrationIntegrationLogger(t *testing.T, notify func(attachmentMigrationIntegrationEvent)) *slog.Logger {
	t.Helper()
	return slog.New(slog.NewJSONHandler(attachmentMigrationIntegrationLog{t: t, notify: notify}, nil))
}

func TestAttachmentMigrationPreservesRealLegacyTrees(t *testing.T) {
	fixture := attachmentMigrationIntegrationSetup(t)
	fixture.seed(t)
	beforeDatabase := fixture.databaseSnapshot(t)
	legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
	other := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "another-bucket"))
	plan := fixture.requireRun(t, "plan", "")
	if plan.Phase != "planned" || plan.TaskCount != 5 || plan.FileCount != 5 || plan.UnregisteredCount != 1 || plan.ReceiptPath != nil {
		t.Fatalf("plan summary: %#v", plan)
	}
	var total int64
	for _, data := range fixture.files {
		total += int64(len(data))
	}
	if plan.TotalBytes != total || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) ||
		!reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) {
		t.Fatal("planning changed source data or misreported its byte inventory")
	}
	manifest, err := os.ReadFile(filepath.Join(fixture.root, filepath.FromSlash(plan.ManifestPath)))
	if err != nil {
		t.Fatal(err)
	}
	complete := fixture.requireRun(t, "apply", plan.OperationID)
	if complete.Phase != "complete" || complete.ReceiptPath == nil || complete.FileCount != plan.FileCount || complete.UnregisteredCount != 1 {
		t.Fatalf("completion summary: %#v", complete)
	}
	fixture.assertPublished(t, legacy)
	if !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) ||
		!reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "another-bucket")), other) {
		t.Fatal("layout maintenance changed PostgreSQL rows or another bucket")
	}
	currentManifest, err := os.ReadFile(filepath.Join(fixture.root, filepath.FromSlash(plan.ManifestPath)))
	if err != nil || !bytes.Equal(currentManifest, manifest) {
		t.Fatalf("immutable plan changed: %v", err)
	}
	wholeRoot := attachmentMigrationIntegrationTree(t, fixture.root)
	for _, action := range []string{"apply", "resume"} {
		if actual := fixture.requireRun(t, action, plan.OperationID); !reflect.DeepEqual(actual, complete) {
			t.Fatalf("completed %s differs: %#v", action, actual)
		}
		if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, fixture.root), wholeRoot) {
			t.Fatalf("completed %s changed filesystem content", action)
		}
	}
	_, err = fixture.run(t, "plan", "")
	if rejected := attachmentMigrationIntegrationError(t, err, "already_migrated"); rejected.OperationID != plan.OperationID {
		t.Fatalf("new plan did not identify the completed operation: %#v", rejected)
	}
}

func TestAttachmentMigrationRejectsInconsistentLegacySourcesBeforeMoves(t *testing.T) {
	for _, category := range []string{"missing", "size", "metadata_owner", "task_owner", "unknown_task", "symlink", "invalid_metadata"} {
		t.Run(category, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			owner := fixture.owners[0]
			file := filepath.Join(fixture.root, "task-attachments", owner.taskID, "文档 space", "binary%_?#.bin")
			wantCategory := "ownership"
			switch category {
			case "missing":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				wantCategory = "missing_content"
			case "size":
				if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE task_attachments SET size_bytes=size_bytes+1 WHERE task_id=$1`, owner.taskID); err != nil {
					t.Fatal(err)
				}
				wantCategory = "missing_content"
			case "metadata_owner":
				if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE task_attachments SET project_id=$1 WHERE task_id=$2`, fixture.projects[1], owner.taskID); err != nil {
					t.Fatal(err)
				}
			case "task_owner":
				if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE tasks SET project_id='ff000000-0000-4000-8000-000000000099' WHERE id=$1`, owner.taskID); err != nil {
					t.Fatal(err)
				}
			case "unknown_task":
				if err := os.Mkdir(filepath.Join(fixture.root, "task-attachments", "ff000000-0000-4000-8000-000000000099"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("unregistered.bin", filepath.Join(fixture.root, "task-attachments", owner.taskID, "alias")); err != nil {
					t.Fatal(err)
				}
				wantCategory = "unsafe_entry"
			case "invalid_metadata":
				if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE task_attachments SET path='C:/file' WHERE task_id=$1`, owner.taskID); err != nil {
					t.Fatal(err)
				}
				wantCategory = "invalid_metadata"
			}
			beforeTree, beforeDatabase := attachmentMigrationIntegrationTree(t, fixture.root), fixture.databaseSnapshot(t)
			_, err := fixture.run(t, "plan", "")
			attachmentMigrationIntegrationError(t, err, wantCategory)
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, fixture.root), beforeTree) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("rejected source inventory changed files or PostgreSQL")
			}
		})
	}
}

func TestAttachmentMigrationResumesAfterObservedPhaseCancellation(t *testing.T) {
	for _, step := range []string{"plan_created", "bucket_evacuated", "task_moved", "target_verified", "bucket_published", "complete"} {
		t.Run(step, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			beforeDatabase := fixture.databaseSnapshot(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			observed := false
			logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
				if event.Step == step && !observed {
					observed = true
					cancel()
				}
			})
			var plan AttachmentMigrationSummary
			if step == "plan_created" {
				var err error
				plan, err = MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "plan", "", logger)
				if err != nil {
					t.Fatalf("persisted plan: %v", err)
				}
			} else {
				plan = fixture.requireRun(t, "plan", "")
				_, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "apply", plan.OperationID, logger)
				if step == "complete" {
					if err != nil {
						t.Fatalf("persisted completion: %v", err)
					}
				} else if !errors.Is(err, context.Canceled) {
					t.Fatalf("canceled %s lost its cause: %v", step, err)
				}
			}
			if !observed {
				t.Fatalf("lifecycle step %s was not emitted", step)
			}
			if complete := fixture.requireRun(t, "resume", plan.OperationID); complete.Phase != "complete" {
				t.Fatalf("resumed phase: %#v", complete)
			}
			fixture.assertPublished(t, legacy)
			if !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("cancel/resume changed PostgreSQL rows")
			}
		})
	}
}

func TestAttachmentMigrationChecksFreshMetadataBeforeMovingAndPublishing(t *testing.T) {
	for _, phase := range []string{"before_apply", "before_publish"} {
		t.Run(phase, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			beforeDatabase := fixture.databaseSnapshot(t)
			plan := fixture.requireRun(t, "plan", "")
			mutate := func() {
				if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE tasks SET title='Changed during migration' WHERE id=$1`, fixture.owners[0].taskID); err != nil {
					t.Fatal(err)
				}
			}
			logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
			injected := false
			if phase == "before_apply" {
				mutate()
			} else {
				logger = attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
					if event.Step == "target_verified" && !injected {
						injected = true
						mutate()
					}
				})
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "apply", plan.OperationID, logger)
			attachmentMigrationIntegrationError(t, err, "metadata_changed")
			if phase == "before_apply" {
				if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) {
					t.Fatal("metadata drift before apply moved legacy content")
				}
			} else {
				if !injected {
					t.Fatal("prepublication metadata drift was not injected")
				}
				if _, err := os.Stat(filepath.Join(fixture.root, "task-attachments")); !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("metadata drift published the final bucket: %v", err)
				}
			}
			if _, err := fixture.database.Pool.Exec(t.Context(), `UPDATE tasks SET title='Migration fixture' WHERE id=$1`, fixture.owners[0].taskID); err != nil {
				t.Fatal(err)
			}
			fixture.requireRun(t, "resume", plan.OperationID)
			fixture.assertPublished(t, legacy)
			if !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("drift recovery changed database rows beyond the controlled mutation")
			}
		})
	}
}

func TestAttachmentMigrationUnregisteredCollisionRequiresItsOriginalOperation(t *testing.T) {
	fixture := attachmentMigrationIntegrationSetup(t)
	owner := fixture.addTask(t, fixture.projects[0], fixture.projects[0])
	fixture.writeLegacy(t, owner, "unregistered.bin", []byte("only unregistered bytes"), false)
	legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
	beforeDatabase := fixture.databaseSnapshot(t)
	plan := fixture.requireRun(t, "plan", "")
	if plan.UnregisteredCount != 1 {
		t.Fatalf("unregistered inventory: %#v", plan)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
		if event.Step == "bucket_evacuated" {
			cancel()
		}
	})
	if _, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "apply", plan.OperationID, logger); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled source evacuation: %v", err)
	}
	_, err := fixture.run(t, "plan", "")
	if blocked := attachmentMigrationIntegrationError(t, err, "resume_required"); blocked.OperationID != plan.OperationID {
		t.Fatalf("incomplete operation was mistaken for an empty install: %#v", blocked)
	}
	fixture.requireRun(t, "resume", plan.OperationID)
	fixture.assertPublished(t, legacy)
	completeTree := attachmentMigrationIntegrationTree(t, fixture.root)
	_, err = fixture.run(t, "plan", "")
	if blocked := attachmentMigrationIntegrationError(t, err, "already_migrated"); blocked.OperationID != plan.OperationID {
		t.Fatalf("completed collision layout was mistaken for legacy layout: %#v", blocked)
	}
	fixture.requireRun(t, "resume", plan.OperationID)
	if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, fixture.root), completeTree) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
		t.Fatal("completed unregistered collision migration was repeated or changed data")
	}
}

func TestAttachmentMigrationEmptyPlanAndInvalidOperationDoNotMoveData(t *testing.T) {
	fixture := attachmentMigrationIntegrationSetup(t)
	beforeDatabase := fixture.databaseSnapshot(t)
	plan := fixture.requireRun(t, "plan", "")
	if plan.TaskCount != 0 || plan.FileCount != 0 || plan.TotalBytes != 0 || plan.UnregisteredCount != 0 || plan.OperationID == "" {
		t.Fatalf("empty plan: %#v", plan)
	}
	complete := fixture.requireRun(t, "apply", plan.OperationID)
	if complete.ReceiptPath == nil || complete.Phase != "complete" {
		t.Fatalf("empty completion: %#v", complete)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "task-attachments")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("empty migration unexpectedly created a bucket: %v", err)
	}
	_, err := fixture.run(t, "resume", "invalid-operation")
	attachmentMigrationIntegrationError(t, err, "invalid_input")
	if !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
		t.Fatal("empty or invalid operation changed PostgreSQL")
	}
}

func TestAttachmentMigrationDoesNotOverwriteAConflictingTarget(t *testing.T) {
	fixture := attachmentMigrationIntegrationSetup(t)
	fixture.seed(t)
	plan := fixture.requireRun(t, "plan", "")
	owner := fixture.owners[0]
	destination := filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID, "target", owner.projectID, owner.taskID[:2], owner.taskID)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	injected := false
	logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
		if event.Step == "bucket_evacuated" && !injected {
			injected = true
			if err := os.MkdirAll(destination, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(destination, "sentinel"), []byte("must not replace"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	})
	_, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "apply", plan.OperationID, logger)
	if err == nil || !injected {
		t.Fatalf("conflicting target was accepted: %v", err)
	}
	if actual, err := os.ReadFile(filepath.Join(destination, "sentinel")); err != nil || string(actual) != "must not replace" {
		t.Fatalf("conflicting destination was overwritten: %q, %v", actual, err)
	}
	source := filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID, "source", owner.taskID, "文档 space", "binary%_?#.bin")
	if actual, err := os.ReadFile(source); err != nil || !bytes.Equal(actual, fixture.files[owner.taskID+"/文档 space/binary%_?#.bin"]) {
		t.Fatalf("source content was lost during target conflict: %v, %v", actual, err)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "task-attachments")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("conflicting target published a final bucket: %v", err)
	}
}

func (fixture *attachmentMigrationIntegrationFixture) stopAfter(t *testing.T, step string) (AttachmentMigrationSummary, attachmentMigrationIntegrationEvent) {
	t.Helper()
	plan := fixture.requireRun(t, "plan", "")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	var observed attachmentMigrationIntegrationEvent
	logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
		if event.Step == step && observed.Step == "" {
			observed = event
			cancel()
		}
	})
	_, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "apply", plan.OperationID, logger)
	if observed.Step != step || !errors.Is(err, context.Canceled) {
		t.Fatalf("stop after %s: event=%#v err=%v", step, observed, err)
	}
	return plan, observed
}

func (fixture *attachmentMigrationIntegrationFixture) setPhase(t *testing.T, operationID, phase string) {
	t.Helper()
	name := filepath.Join(fixture.root, ".attachment-layout-"+operationID, "state.json")
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	state["phase"] = phase
	data, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (fixture *attachmentMigrationIntegrationFixture) requireRejectedState(t *testing.T, action, operationID, category string) {
	t.Helper()
	beforeTree, beforeDatabase := attachmentMigrationIntegrationTree(t, fixture.root), fixture.databaseSnapshot(t)
	_, err := fixture.run(t, action, operationID)
	attachmentMigrationIntegrationError(t, err, category)
	if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, fixture.root), beforeTree) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
		t.Fatal("rejected migration state changed its persisted files or database")
	}
}

func (fixture *attachmentMigrationIntegrationFixture) sourceOwner(t *testing.T, operationID string) attachmentMigrationIntegrationOwner {
	t.Helper()
	for _, owner := range fixture.owners {
		if info, err := os.Stat(filepath.Join(fixture.root, ".attachment-layout-"+operationID, "source", owner.taskID)); err == nil && info.IsDir() {
			return owner
		}
	}
	t.Fatal("fixture has no remaining source task")
	return attachmentMigrationIntegrationOwner{}
}

func (fixture *attachmentMigrationIntegrationFixture) taskFile(t *testing.T, directory, taskID string) string {
	t.Helper()
	for name := range fixture.files {
		if strings.HasPrefix(name, taskID+"/") {
			return filepath.Join(directory, filepath.FromSlash(strings.TrimPrefix(name, taskID+"/")))
		}
	}
	t.Fatal("fixture task has no ordinary file")
	return ""
}

func TestAttachmentMigrationRejectsChangedEmptyBucketAndUnexpectedEmptyState(t *testing.T) {
	for _, mutation := range []string{"unchanged", "extra_file", "unexpected_phase", "unexpected_source"} {
		t.Run(mutation, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			bucket := filepath.Join(fixture.root, "task-attachments")
			if err := os.Mkdir(bucket, 0o700); err != nil {
				t.Fatal(err)
			}
			plan := fixture.requireRun(t, "plan", "")
			switch mutation {
			case "unchanged":
				fixture.requireRun(t, "apply", plan.OperationID)
				if actual := attachmentMigrationIntegrationTree(t, bucket); !reflect.DeepEqual(actual, map[string]attachmentMigrationIntegrationEntry{".": {mode: fs.ModeDir}}) {
					t.Fatalf("empty bucket changed: %#v", actual)
				}
				return
			case "extra_file":
				if err := os.WriteFile(filepath.Join(bucket, "unexpected.bin"), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				fixture.requireRejectedState(t, "apply", plan.OperationID, "content_changed")
			case "unexpected_phase":
				fixture.setPhase(t, plan.OperationID, "evacuated")
				fixture.requireRejectedState(t, "resume", plan.OperationID, "operation_conflict")
			case "unexpected_source":
				if err := os.Mkdir(filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID, "source"), 0o700); err != nil {
					t.Fatal(err)
				}
				fixture.requireRejectedState(t, "resume", plan.OperationID, "operation_conflict")
			}
		})
	}
}

func TestAttachmentMigrationRejectsContradictoryTopLevelLocations(t *testing.T) {
	for _, mutation := range []string{"bucket_file", "source_file", "target_file", "both_bucket_source", "all_locations_missing", "legacy_bytes_changed"} {
		t.Run(mutation, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			plan := fixture.requireRun(t, "plan", "")
			operation := filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID)
			category := "operation_conflict"
			switch mutation {
			case "bucket_file":
				if err := os.Rename(filepath.Join(fixture.root, "task-attachments"), filepath.Join(fixture.root, "retained-bucket")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(fixture.root, "task-attachments"), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "unsafe_entry"
			case "source_file", "target_file":
				name := strings.TrimSuffix(mutation, "_file")
				if err := os.WriteFile(filepath.Join(operation, name), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "unsafe_entry"
			case "both_bucket_source":
				if err := os.Mkdir(filepath.Join(operation, "source"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "all_locations_missing":
				if err := os.Rename(filepath.Join(fixture.root, "task-attachments"), filepath.Join(fixture.root, "retained-bucket")); err != nil {
					t.Fatal(err)
				}
			case "legacy_bytes_changed":
				name := fixture.taskFile(t, filepath.Join(fixture.root, "task-attachments", fixture.owners[0].taskID), fixture.owners[0].taskID)
				if err := os.WriteFile(name, []byte("changed after planning"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			}
			fixture.requireRejectedState(t, "resume", plan.OperationID, category)
		})
	}
}

func TestAttachmentMigrationResumesSourceOnlyStateAndRejectsMissingVerifiedTarget(t *testing.T) {
	for _, state := range []string{"source_only", "changed_source_only", "missing_verified_target"} {
		t.Run(state, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			step := "bucket_evacuated"
			if state == "missing_verified_target" {
				step = "target_verified"
			}
			plan, _ := fixture.stopAfter(t, step)
			operation := filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID)
			target := filepath.Join(operation, "target")
			if state == "missing_verified_target" {
				if err := os.Rename(target, filepath.Join(fixture.root, "retained-target")); err != nil {
					t.Fatal(err)
				}
				fixture.requireRejectedState(t, "resume", plan.OperationID, "operation_conflict")
				return
			}
			for _, entry := range attachmentMigrationIntegrationTree(t, target) {
				if entry.mode != fs.ModeDir {
					t.Fatal("source-only fixture would discard moved file content")
				}
			}
			if err := os.RemoveAll(target); err != nil {
				t.Fatal(err)
			}
			if state == "changed_source_only" {
				name := fixture.taskFile(t, filepath.Join(operation, "source", fixture.owners[0].taskID), fixture.owners[0].taskID)
				if err := os.WriteFile(name, []byte("changed staged content"), 0o600); err != nil {
					t.Fatal(err)
				}
				fixture.requireRejectedState(t, "resume", plan.OperationID, "content_changed")
				return
			}
			fixture.requireRun(t, "resume", plan.OperationID)
			fixture.assertPublished(t, legacy)
		})
	}
}

func TestAttachmentMigrationRejectsPartialPlacementDamage(t *testing.T) {
	mutations := []string{"apply_again", "planned_with_target", "verified_with_source", "both_task_locations", "missing_task_locations", "source_is_file", "target_is_file", "source_bytes_changed", "source_symlink", "extra_source_task", "extra_target_entry", "target_bytes_changed", "target_entry_missing"}
	for _, mutation := range mutations {
		t.Run(mutation, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			plan, moved := fixture.stopAfter(t, "task_moved")
			operation := filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID)
			remaining := fixture.sourceOwner(t, plan.OperationID)
			var movedOwner attachmentMigrationIntegrationOwner
			for _, owner := range fixture.owners {
				if owner.taskID == moved.TaskID {
					movedOwner = owner
				}
			}
			if movedOwner.taskID == "" {
				t.Fatal("moved task event has no fixture owner")
			}
			source := filepath.Join(operation, "source", remaining.taskID)
			target := filepath.Join(operation, "target", movedOwner.projectID, movedOwner.taskID[:2], movedOwner.taskID)
			action, category := "resume", "operation_conflict"
			switch mutation {
			case "apply_again":
				action, category = "apply", "resume_required"
			case "planned_with_target":
				fixture.setPhase(t, plan.OperationID, "planned")
			case "verified_with_source":
				fixture.setPhase(t, plan.OperationID, "verified")
			case "both_task_locations":
				if err := os.Mkdir(filepath.Join(operation, "source", movedOwner.taskID), 0o700); err != nil {
					t.Fatal(err)
				}
			case "missing_task_locations":
				if err := os.Rename(source, filepath.Join(fixture.root, "retained-task")); err != nil {
					t.Fatal(err)
				}
			case "source_is_file":
				if err := os.Rename(source, filepath.Join(fixture.root, "retained-task")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(source, []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "unsafe_entry"
			case "target_is_file":
				name := filepath.Join(operation, "target", remaining.projectID, remaining.taskID[:2], remaining.taskID)
				if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(name, []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "unsafe_entry"
			case "source_bytes_changed":
				if err := os.WriteFile(fixture.taskFile(t, source, remaining.taskID), []byte("changed staged bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			case "source_symlink":
				name := fixture.taskFile(t, source, remaining.taskID)
				if err := os.Rename(name, name+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Base(name)+".retained", name); err != nil {
					t.Fatal(err)
				}
				category = "unsafe_entry"
			case "extra_source_task":
				if err := os.Mkdir(filepath.Join(operation, "source", "ff000000-0000-4000-8000-000000000099"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "extra_target_entry":
				if err := os.WriteFile(filepath.Join(target, "unexpected.bin"), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			case "target_bytes_changed":
				if err := os.WriteFile(fixture.taskFile(t, target, movedOwner.taskID), []byte("changed placed bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			case "target_entry_missing":
				if err := os.Rename(fixture.taskFile(t, target, movedOwner.taskID), filepath.Join(fixture.root, "retained-file")); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			}
			fixture.requireRejectedState(t, action, plan.OperationID, category)
		})
	}
}

func TestAttachmentMigrationRejectsPublishedSourceLeftoversAndChangedBytes(t *testing.T) {
	for _, mutation := range []string{"source_leftover", "published_bytes"} {
		t.Run(mutation, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			plan, _ := fixture.stopAfter(t, "bucket_published")
			category := "operation_conflict"
			if mutation == "source_leftover" {
				if err := os.WriteFile(filepath.Join(fixture.root, ".attachment-layout-"+plan.OperationID, "source", "unexpected.bin"), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				owner := fixture.owners[0]
				name := fixture.taskFile(t, filepath.Join(fixture.root, "task-attachments", owner.projectID, owner.taskID[:2], owner.taskID), owner.taskID)
				if err := os.WriteFile(name, []byte("changed published bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
				category = "content_changed"
			}
			fixture.requireRejectedState(t, "resume", plan.OperationID, category)
		})
	}
}

func attachmentMigrationIntegrationPlanPair(t *testing.T, root, directory, operationID string) {
	t.Helper()
	manifest, err := os.ReadFile(filepath.Join(root, directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	state, err := os.ReadFile(filepath.Join(root, directory, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var planned struct {
		OperationID string `json:"operationId"`
	}
	var stage struct {
		OperationID    string `json:"operationId"`
		Phase          string `json:"phase"`
		ManifestSHA256 string `json:"manifestSha256"`
	}
	if err := json.Unmarshal(manifest, &planned); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(state, &stage); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifest)
	if planned.OperationID != operationID || stage.OperationID != operationID || stage.Phase != "planned" || stage.ManifestSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("published plan does not contain its complete matching record pair: manifest=%#v state=%#v", planned, stage)
	}
}

func TestAttachmentMigrationPublishesOnlyCompletePlanRecordPair(t *testing.T) {
	fixture := attachmentMigrationIntegrationSetup(t)
	fixture.seed(t)
	legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
	beforeDatabase := fixture.databaseSnapshot(t)
	var milestones []string
	logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
		private := ".attachment-plan-" + event.OperationID
		official := ".attachment-layout-" + event.OperationID
		switch event.Step {
		case "plan_initializing":
			milestones = append(milestones, event.Step)
			if _, err := os.Stat(filepath.Join(fixture.root, private)); err != nil {
				t.Fatalf("initializer namespace does not exist: %v", err)
			}
			for _, name := range []string{"manifest.json", "state.json"} {
				if _, err := os.Stat(filepath.Join(fixture.root, private, name)); !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("initializer announced after creating %s: %v", name, err)
				}
			}
			if _, err := os.Stat(filepath.Join(fixture.root, official)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("incomplete operation is visible in the official namespace: %v", err)
			}
		case "plan_prepared":
			milestones = append(milestones, event.Step)
			attachmentMigrationIntegrationPlanPair(t, fixture.root, private, event.OperationID)
			if _, err := os.Stat(filepath.Join(fixture.root, official)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("operation published before its complete record pair was prepared: %v", err)
			}
		case "plan_created":
			milestones = append(milestones, event.Step)
			attachmentMigrationIntegrationPlanPair(t, fixture.root, official, event.OperationID)
			if _, err := os.Stat(filepath.Join(fixture.root, private)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("published operation retained its initializer path: %v", err)
			}
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	plan, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "plan", "", logger)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(milestones, []string{"plan_initializing", "plan_prepared", "plan_created"}) {
		t.Fatalf("plan publication lifecycle: %v", milestones)
	}
	if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
		t.Fatal("atomic plan publication changed legacy bytes or business metadata")
	}
	fixture.requireRun(t, "apply", plan.OperationID)
	fixture.assertPublished(t, legacy)
}

func TestAttachmentMigrationUnpublishedInitializationDoesNotBlockNewPlan(t *testing.T) {
	for _, interrupted := range []string{"empty", "partial_manifest", "missing_state", "partial_state"} {
		t.Run(interrupted, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			beforeDatabase := fixture.databaseSnapshot(t)
			prepared := fixture.requireRun(t, "plan", "")
			private := filepath.Join(fixture.root, ".attachment-plan-"+prepared.OperationID)
			if err := os.Rename(filepath.Join(fixture.root, ".attachment-layout-"+prepared.OperationID), private); err != nil {
				t.Fatal(err)
			}
			switch interrupted {
			case "empty":
				for _, name := range []string{"manifest.json", "state.json"} {
					if err := os.Remove(filepath.Join(private, name)); err != nil {
						t.Fatal(err)
					}
				}
			case "partial_manifest":
				if err := os.WriteFile(filepath.Join(private, "manifest.json"), []byte(`{"version":1,"operationId":`), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(private, "state.json")); err != nil {
					t.Fatal(err)
				}
			case "missing_state":
				if err := os.Remove(filepath.Join(private, "state.json")); err != nil {
					t.Fatal(err)
				}
			case "partial_state":
				if err := os.WriteFile(filepath.Join(private, "state.json"), []byte(`{"phase":"planned"`), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			leftovers := attachmentMigrationIntegrationTree(t, private)
			plan := fixture.requireRun(t, "plan", "")
			if plan.OperationID == prepared.OperationID {
				t.Fatal("fresh plan reused an unpublished interrupted operation")
			}
			attachmentMigrationIntegrationPlanPair(t, fixture.root, ".attachment-layout-"+plan.OperationID, plan.OperationID)
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, private), leftovers) ||
				!reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("fresh plan altered ignored initializer remnants, legacy bytes or business metadata")
			}
			fixture.requireRun(t, "apply", plan.OperationID)
			fixture.assertPublished(t, legacy)
			fixture.requireRun(t, "resume", plan.OperationID)
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, private), leftovers) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("completed fresh operation changed ignored initializer remnants or metadata")
			}
		})
	}
}

func TestAttachmentMigrationInitializationFailureLeavesFreshPlanAvailable(t *testing.T) {
	for _, failure := range []string{"cancel_before_records", "cancel_before_promotion", "stage_record_conflict"} {
		t.Run(failure, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			beforeDatabase := fixture.databaseSnapshot(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			interruptedID := ""
			logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
				if interruptedID != "" {
					return
				}
				if failure == "cancel_before_promotion" && event.Step == "plan_prepared" {
					attachmentMigrationIntegrationPlanPair(t, fixture.root, ".attachment-plan-"+event.OperationID, event.OperationID)
					interruptedID = event.OperationID
					cancel()
				} else if failure != "cancel_before_promotion" && event.Step == "plan_initializing" {
					interruptedID = event.OperationID
					if failure == "cancel_before_records" {
						cancel()
					} else if err := os.Mkdir(filepath.Join(fixture.root, ".attachment-plan-"+event.OperationID, "state.json"), 0o700); err != nil {
						t.Fatal(err)
					}
				}
			})
			_, err := MigrateAttachmentLayout(ctx, fixture.databaseURL, fixture.root, "plan", "", logger)
			if interruptedID == "" || err == nil {
				t.Fatalf("initializer failure was not observed: operation=%s err=%v", interruptedID, err)
			}
			if failure == "stage_record_conflict" {
				attachmentMigrationIntegrationError(t, err, "operation_conflict")
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("initialization cancellation lost its cause: %v", err)
			}
			if _, err := os.Stat(filepath.Join(fixture.root, ".attachment-layout-"+interruptedID)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("failed initializer published an incomplete official operation: %v", err)
			}
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("failed initializer changed legacy bytes or metadata")
			}
			plan := fixture.requireRun(t, "plan", "")
			attachmentMigrationIntegrationPlanPair(t, fixture.root, ".attachment-layout-"+plan.OperationID, plan.OperationID)
			fixture.requireRun(t, "apply", plan.OperationID)
			fixture.assertPublished(t, legacy)
			if !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("fresh plan/apply after initializer failure changed business metadata")
			}
		})
	}
}

func TestAttachmentMigrationHardStopDuringPlanInitialization(t *testing.T) {
	if os.Getenv("DAYNIGHT_ATTACHMENT_INITIALIZER_CHILD") == "1" {
		step := os.Getenv("DAYNIGHT_ATTACHMENT_INITIALIZER_STEP")
		logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
			if event.Step != step {
				return
			}
			if err := json.NewEncoder(os.Stdout).Encode(event); err != nil {
				t.Fatal(err)
			}
			<-make(chan struct{})
		})
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		_, err := MigrateAttachmentLayout(ctx, os.Getenv("DAYNIGHT_ATTACHMENT_INITIALIZER_DATABASE"),
			os.Getenv("DAYNIGHT_ATTACHMENT_INITIALIZER_ROOT"), "plan", "", logger)
		t.Fatalf("initializer returned before its hard-stop checkpoint %q: %v", step, err)
	}
	for _, step := range []string{"plan_initializing", "plan_prepared"} {
		t.Run(step, func(t *testing.T) {
			fixture := attachmentMigrationIntegrationSetup(t)
			fixture.seed(t)
			legacy := attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments"))
			beforeDatabase := fixture.databaseSnapshot(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAttachmentMigrationHardStopDuringPlanInitialization$")
			for _, entry := range os.Environ() {
				if !strings.HasPrefix(entry, "DAYNIGHT_ATTACHMENT_INITIALIZER_") {
					child.Env = append(child.Env, entry)
				}
			}
			child.Env = append(child.Env, "DAYNIGHT_ATTACHMENT_INITIALIZER_CHILD=1", "DAYNIGHT_ATTACHMENT_INITIALIZER_STEP="+step,
				"DAYNIGHT_ATTACHMENT_INITIALIZER_DATABASE="+fixture.databaseURL, "DAYNIGHT_ATTACHMENT_INITIALIZER_ROOT="+fixture.root)
			var diagnostic bytes.Buffer
			child.Stderr = &diagnostic
			stdout, err := child.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			waited := false
			stopChild := func() {
				if !waited {
					_ = child.Process.Kill()
					_ = child.Wait()
					waited = true
				}
			}
			t.Cleanup(stopChild)
			type received struct {
				event attachmentMigrationIntegrationEvent
				err   error
			}
			ready := make(chan received, 1)
			go func() {
				var event attachmentMigrationIntegrationEvent
				err := json.NewDecoder(stdout).Decode(&event)
				ready <- received{event: event, err: err}
			}()
			var stopped attachmentMigrationIntegrationEvent
			select {
			case result := <-ready:
				if result.err != nil {
					stopChild()
					t.Fatalf("initializer checkpoint: %v; stderr=%s", result.err, diagnostic.String())
				}
				stopped = result.event
			case <-ctx.Done():
				stopChild()
				t.Fatalf("initializer did not reach %s before timeout: %v; stderr=%s", step, ctx.Err(), diagnostic.String())
			}
			if stopped.Step != step || stopped.OperationID == "" {
				t.Fatalf("unexpected child checkpoint: %#v", stopped)
			}
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			err = child.Wait()
			waited = true
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.Success() {
				t.Fatalf("initializer was not terminated at its checkpoint: %v", err)
			}
			private := filepath.Join(fixture.root, ".attachment-plan-"+stopped.OperationID)
			if step == "plan_initializing" {
				entries, err := os.ReadDir(private)
				if err != nil || len(entries) != 0 {
					t.Fatalf("hard stop before manifest did not leave an empty private initializer: %v, %v", entries, err)
				}
			} else {
				attachmentMigrationIntegrationPlanPair(t, fixture.root, ".attachment-plan-"+stopped.OperationID, stopped.OperationID)
			}
			if _, err := os.Stat(filepath.Join(fixture.root, ".attachment-layout-"+stopped.OperationID)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("hard-stopped initializer published an official operation: %v", err)
			}
			leftovers := attachmentMigrationIntegrationTree(t, private)
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, filepath.Join(fixture.root, "task-attachments")), legacy) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("hard-stopped initializer changed legacy content or business metadata")
			}
			plan := fixture.requireRun(t, "plan", "")
			attachmentMigrationIntegrationPlanPair(t, fixture.root, ".attachment-layout-"+plan.OperationID, plan.OperationID)
			fixture.requireRun(t, "apply", plan.OperationID)
			fixture.assertPublished(t, legacy)
			fixture.requireRun(t, "resume", plan.OperationID)
			if !reflect.DeepEqual(attachmentMigrationIntegrationTree(t, private), leftovers) || !reflect.DeepEqual(fixture.databaseSnapshot(t), beforeDatabase) {
				t.Fatal("fresh plan/apply after hard termination changed abandoned private state or business metadata")
			}
		})
	}
}
