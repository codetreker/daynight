package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentReadsUseTaskPresence(t *testing.T) {
	subject, m, files, task, p := attachmentUnit(t)
	item := attachmentItem(task, "file", "text/plain", 7)
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("content")); err != nil {
		t.Fatal(err)
	}
	m.read(p, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 10}).result = store.AttachmentPage{Items: []model.Attachment{item}}
	page, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %#v %v", page, err)
	}
	planAttachmentOpen(m, p, task, item)
	_, obj, err := subject.Open(t.Context(), p, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(obj.Body)
	closeErr := obj.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "content" {
		t.Fatalf("open: %q %v %v", content, readErr, closeErr)
	}
}

func TestAttachmentPresenceErrorAndAuthorizationSemantics(t *testing.T) {
	subject, m, _, task, p := attachmentUnit(t)
	for _, action := range []string{"list", "open"} {
		run := func(actor model.Principal, taskID string) error {
			if action == "list" {
				_, err := subject.List(t.Context(), actor, task.ProjectID, taskID, model.PageRequest{Limit: 1})
				return err
			}
			_, obj, err := subject.Open(t.Context(), actor, task.ProjectID, taskID, "file")
			if err == nil {
				_ = obj.Body.Close()
			}
			return err
		}
		missing := "ab000000-0000-4000-8000-000000000002"
		m.expect("snapshot").callback = true
		m.expect("access", p, task.ProjectID).result = model.ProjectAccess{}
		m.expect("presence", task.ProjectID, missing).result = store.TaskPresence{Found: false}
		requireFault(t, run(p, missing), "not_found")
		outsider := p
		outsider.UserID = "ef000000-0000-4000-8000-000000000003"
		m.expect("snapshot").callback = true
		m.expect("access", outsider, task.ProjectID).err = model.ErrNotFound
		requireFault(t, run(outsider, task.ID), "not_found")
		failure := errors.New("presence query failed")
		m.expect("snapshot").callback = true
		m.expect("access", p, task.ProjectID).result = model.ProjectAccess{}
		m.expect("presence", task.ProjectID, task.ID).err = failure
		if err := run(p, task.ID); !errors.Is(err, failure) {
			t.Fatalf("%s presence error: %v", action, err)
		}
		failure = errors.New("snapshot failed")
		m.expect("snapshot").err = failure
		if err := run(p, task.ID); !errors.Is(err, failure) {
			t.Fatalf("%s snapshot error: %v", action, err)
		}
		deleted := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		m.expect("snapshot").callback = true
		m.expect("access", p, task.ProjectID).result = model.ProjectAccess{}
		m.expect("presence", task.ProjectID, task.ID).result = store.TaskPresence{Found: true, DeletedAt: &deleted}
		err := run(p, task.ID)
		requireFault(t, err, "task_deleted")
		if !errors.Is(err, model.ErrTaskDeleted) {
			t.Fatalf("deleted task cause: %v", err)
		}
	}
}
