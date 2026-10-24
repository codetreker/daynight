package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
)

type attachmentStorageCall struct {
	operation string
	bucket    string
	path      string
}

type attachmentRecordedStorage struct {
	filestorage.Storage
	calls []attachmentStorageCall
}

func (s *attachmentRecordedStorage) Put(ctx context.Context, bucket, path string, content io.Reader) (filestorage.FileInfo, error) {
	s.calls = append(s.calls, attachmentStorageCall{"put", bucket, path})
	return s.Storage.Put(ctx, bucket, path, content)
}

func (s *attachmentRecordedStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	s.calls = append(s.calls, attachmentStorageCall{"open", bucket, path})
	return s.Storage.Open(ctx, bucket, path)
}

func (s *attachmentRecordedStorage) Delete(ctx context.Context, bucket, path string) error {
	s.calls = append(s.calls, attachmentStorageCall{"delete", bucket, path})
	return s.Storage.Delete(ctx, bucket, path)
}

func TestAttachmentProjectAndTaskShardIsolation(t *testing.T) {
	ctx := t.Context()
	tasks, database, project, _, principal := taskService(t)
	otherProject, err := NewProjects(database).Create(ctx, principal, CreateProject{Name: "Other attachment project", RepoURL: "host:other-attachments"})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	recorded := &attachmentRecordedStorage{Storage: files}
	attachments := NewAttachments(database, recorded)
	createFixedTask := func(projectID, taskID string) core.Task {
		t.Helper()
		if _, err := database.Pool.Exec(ctx, `INSERT INTO tasks(id, project_id, title) VALUES ($1,$2,'Attachment isolation')`, taskID, projectID); err != nil {
			t.Fatal(err)
		}
		task, err := tasks.Get(ctx, principal, projectID, taskID)
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	owners := []core.Task{
		createFixedTask(project.ID, "ab000000-0000-4000-8000-000000000001"),
		createFixedTask(project.ID, "ab000000-0000-4000-8000-000000000002"),
		createFixedTask(project.ID, "cd000000-0000-4000-8000-000000000003"),
		createFixedTask(otherProject.ID, "ab000000-0000-4000-8000-000000000004"),
	}
	path := "文档 space/same%_?#.bin"
	contents := [][]byte{{0, 255, 1}, {0, 255, 2}, {0, 255, 3}, {0, 255, 4}}
	physicalPath := func(task core.Task) string {
		return filepath.Join(root, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "文档 space", "same%_?#.bin")
	}
	assertContent := func(task core.Task, want []byte) {
		t.Helper()
		metadata, object, err := attachments.Open(ctx, principal, task.ProjectID, task.ID, path)
		if err != nil {
			t.Fatal(err)
		}
		got, readErr := io.ReadAll(object.Body)
		if err := errors.Join(readErr, object.Body.Close()); err != nil || !bytes.Equal(got, want) || metadata.Path != path {
			t.Fatalf("logical content for %s: %v metadata=%#v err=%v", task.ID, got, metadata, err)
		}
		physical, err := os.ReadFile(physicalPath(task))
		if err != nil || !bytes.Equal(physical, want) {
			t.Fatalf("physical content for %s: %v err=%v", task.ID, physical, err)
		}
	}
	assertDirectory := func(relative string, exists bool) {
		t.Helper()
		info, err := os.Stat(filepath.Join(root, "task-attachments", relative))
		if exists {
			if err != nil || !info.IsDir() {
				t.Fatalf("directory %s should remain: %v", relative, err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("empty directory %s should be removed: %v", relative, err)
		}
	}
	for index, task := range owners {
		metadata, created, err := attachments.Put(ctx, principal, strings.ToUpper(task.ProjectID), strings.ToUpper(task.ID), path, "application/octet-stream", bytes.NewReader(contents[index]))
		if err != nil || !created || metadata.ProjectID != task.ProjectID || metadata.TaskID != task.ID || metadata.Path != path {
			t.Fatalf("canonical logical metadata: %#v created=%v err=%v", metadata, created, err)
		}
		call := recorded.calls[len(recorded.calls)-1]
		if call != (attachmentStorageCall{"put", "task-attachments", task.ProjectID + "/" + task.ID[:2] + "/" + task.ID + "/" + path}) {
			t.Fatalf("business storage address: %#v", call)
		}
		page, err := attachments.List(ctx, principal, task.ProjectID, task.ID, PageRequest{Limit: 10})
		if err != nil || len(page.Items) != 1 || page.Items[0].Path != path {
			t.Fatalf("logical inventory: %#v err=%v", page, err)
		}
		assertContent(task, contents[index])
	}
	before := len(recorded.calls)
	_, _, err = attachments.Put(ctx, principal, project.ID, owners[3].ID, path, "application/octet-stream", bytes.NewReader(nil))
	requireFault(t, err, "not_found")
	_, _, err = attachments.Open(ctx, principal, otherProject.ID, owners[0].ID, path)
	requireFault(t, err, "not_found")
	requireFault(t, attachments.Delete(ctx, principal, project.ID, owners[3].ID, path), "not_found")
	if len(recorded.calls) != before {
		t.Fatal("mismatched project/task reached storage")
	}
	contents[0] = []byte("replacement")
	if _, created, err := attachments.Put(ctx, principal, project.ID, owners[0].ID, path, "text/plain", bytes.NewReader(contents[0])); err != nil || created {
		t.Fatalf("overwrite: created=%v err=%v", created, err)
	}
	for index, task := range owners {
		assertContent(task, contents[index])
		assertTaskUnchanged(t, tasks, principal, task)
	}
	putAttachment(t, attachments, principal, owners[0], "sibling.txt", "keep task")
	for index, task := range owners {
		if err := attachments.Delete(ctx, principal, task.ProjectID, task.ID, path); err != nil {
			t.Fatal(err)
		}
		call := recorded.calls[len(recorded.calls)-1]
		if call != (attachmentStorageCall{"delete", "task-attachments", task.ProjectID + "/" + task.ID[:2] + "/" + task.ID + "/" + path}) {
			t.Fatalf("deletion storage address: %#v", call)
		}
		if index == 0 {
			assertDirectory(filepath.Join(project.ID, "ab", task.ID), true)
			if err := attachments.Delete(ctx, principal, task.ProjectID, task.ID, "sibling.txt"); err != nil {
				t.Fatal(err)
			}
		}
		assertDirectory(filepath.Join(task.ProjectID, task.ID[:2], task.ID), false)
		for sibling := index + 1; sibling < len(owners); sibling++ {
			assertContent(owners[sibling], contents[sibling])
		}
		switch index {
		case 0:
			assertDirectory(filepath.Join(project.ID, "ab"), true)
		case 1:
			assertDirectory(filepath.Join(project.ID, "ab"), false)
			assertDirectory(project.ID, true)
		case 2:
			assertDirectory(project.ID, false)
			assertDirectory(otherProject.ID, true)
		case 3:
			assertDirectory(otherProject.ID, false)
			assertDirectory("", true)
		}
	}
}
