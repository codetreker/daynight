package service

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func attachmentService(t *testing.T) (*attachmentservice.Attachments, *taskservice.Tasks, *postgres.Store, *local.Storage, model.Task, model.Principal) {
	t.Helper()
	tasks, database, project, _, principal := taskService(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return attachmentservice.NewAttachments(database, database, files), tasks, database, files, createTask(t, tasks, principal, project.ID, "Attachments"), principal
}

func putAttachment(t *testing.T, attachments *attachmentservice.Attachments, principal model.Principal, task model.Task, path, content string) model.Attachment {
	t.Helper()
	attachment, _, err := attachments.Put(context.Background(), principal, task.ProjectID, task.ID, path, "text/plain; charset=utf-8", strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	return attachment
}

func attachmentTestStoragePath(task model.Task, path string) string {
	return task.ProjectID + "/" + task.ID[:2] + "/" + task.ID + "/" + path
}
