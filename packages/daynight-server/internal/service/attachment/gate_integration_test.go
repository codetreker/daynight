package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
)

func TestAttachmentGateOrdersConcurrentInstances(t *testing.T) {
	for _, operations := range [][2]string{{"put", "put"}, {"put", "delete"}, {"delete", "put"}, {"put", "open"}} {
		t.Run(operations[0]+"-"+operations[1], func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Gate ordering")
			root := t.TempDir()
			first, err := local.New(root)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Close()
			second, err := local.New(root)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			a, b := newAttachmentService(database, first), newAttachmentService(database, second)
			putAttachment(t, a, principal, task, "file", "before")
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			oldMetadata, old, err := a.Open(ctx, principal, task.ProjectID, task.ID, "file")
			if err != nil {
				t.Fatal(err)
			}
			observed := &observedAttachmentStorage{Storage: first, reached: make(chan struct{}), release: make(chan struct{})}
			writer := newAttachmentService(database, observed)
			firstResult := make(chan error, 1)
			go func() { firstResult <- attachmentMutation(ctx, writer, principal, task, operations[0]) }()
			select {
			case <-observed.reached:
			case err := <-firstResult:
				t.Fatalf("first operation did not reach file effect: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			started := make(chan struct{})
			secondResult := make(chan error, 1)
			go func() {
				close(started)
				if operations[1] == "open" {
					metadata, object, err := b.Open(ctx, principal, task.ProjectID, task.ID, "file")
					if err != nil {
						secondResult <- err
						return
					}
					content, readErr := io.ReadAll(object.Body)
					closeErr := object.Body.Close()
					if readErr != nil || closeErr != nil || string(content) != "after" || metadata.SizeBytes != int64(len(content)) || metadata.ContentType != "text/plain" {
						secondResult <- fmt.Errorf("mismatched open: %#v %q %v %v", metadata, content, readErr, closeErr)
						return
					}
					secondResult <- nil
					return
				}
				if operations[1] == "put" {
					_, _, err := b.Put(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("second-writer"))
					secondResult <- err
					return
				}
				secondResult <- attachmentMutation(ctx, b, principal, task, "delete")
			}()
			<-started
			select {
			case err := <-secondResult:
				t.Fatalf("second operation passed live writer: %v", err)
			case <-time.After(100 * time.Millisecond):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			close(observed.release)
			if err := attachmentWaitResult(t, ctx, firstResult); err != nil {
				t.Fatal(err)
			}
			if err := attachmentWaitResult(t, ctx, secondResult); err != nil {
				t.Fatal(err)
			}
			content := "after"
			if operations[1] == "put" {
				content = "second-writer"
			}
			assertAttachmentState(t, ctx, database, second, task, operations[1] != "delete", content)
			oldContent, readErr := io.ReadAll(old.Body)
			closeErr := old.Body.Close()
			if readErr != nil || closeErr != nil || string(oldContent) != "before" || oldMetadata.SizeBytes != int64(len(oldContent)) {
				t.Fatalf("old handle: %#v %q %v %v", oldMetadata, oldContent, readErr, closeErr)
			}
		})
	}
}

func TestAttachmentGateProtectsOpenAndSurvivesDatabaseConnectionLoss(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Gate")
	root := t.TempDir()
	first, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	a := newAttachmentService(database, first)
	b := newAttachmentService(database, second)
	putAttachment(t, a, principal, task, "file", "before")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	metadata, old, err := a.Open(ctx, principal, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	observed := &observedAttachmentStorage{Storage: first, reached: make(chan struct{}), release: make(chan struct{})}
	writer := newAttachmentService(database, observed)
	written := make(chan error, 1)
	go func() { written <- attachmentMutation(ctx, writer, principal, task, "put") }()
	select {
	case <-observed.reached:
	case err := <-written:
		t.Fatalf("writer did not publish: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var pid int32
	if err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%task_attachments%' LIMIT 1),0)`).Scan(&pid); err != nil || pid == 0 {
		t.Fatalf("writer transaction not found: %d %v", pid, err)
	}
	if _, err := database.Pool.Exec(ctx, `SELECT pg_terminate_backend($1)`, pid); err != nil {
		t.Fatal(err)
	}
	blockedCtx, blockedCancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer blockedCancel()
	if _, _, err := b.Open(blockedCtx, principal, task.ProjectID, task.ID, "file"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("open passed live writer after database loss: %v", err)
	}
	close(observed.release)
	if err := attachmentWaitResult(t, ctx, written); err == nil {
		t.Fatal("writer succeeded after connection loss")
	}
	if _, _, err := b.Put(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("final")); err != nil {
		t.Fatal(err)
	}
	current, object, err := b.Open(ctx, principal, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "final" || current.SizeBytes != int64(len(content)) || current.ContentType != "text/plain" {
		t.Fatalf("current metadata/content: %#v %q %v %v", current, content, readErr, closeErr)
	}
	oldContent, readErr := io.ReadAll(old.Body)
	closeErr = old.Body.Close()
	if readErr != nil || closeErr != nil || string(oldContent) != "before" || metadata.SizeBytes != int64(len(oldContent)) {
		t.Fatalf("opened object changed: %#v %q %v %v", metadata, oldContent, readErr, closeErr)
	}
	if err := b.Delete(ctx, principal, task.ProjectID, task.ID, "file"); err != nil {
		t.Fatal(err)
	}
	assertAttachmentState(t, ctx, database, second, task, false, "")
}
