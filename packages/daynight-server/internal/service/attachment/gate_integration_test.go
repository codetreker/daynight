package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentGateOrdersConcurrentInstances(t *testing.T) {
	for _, operations := range [][2]string{{"put", "put"}, {"put", "delete"}, {"delete", "put"}, {"put", "open"}} {
		t.Run(operations[0]+"-"+operations[1], func(t *testing.T) {
			_, firstMock, _, task, p := attachmentUnit(t)
			secondMock := newAttachmentMock(t)
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
			if _, err := first.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
				t.Fatal(err)
			}
			old, err := first.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
			if err != nil {
				t.Fatal(err)
			}
			defer old.Body.Close()
			before := attachmentItem(task, "file", "text/plain", 6)
			after := attachmentItem(task, "file", "text/plain", 5)
			next := attachmentItem(task, "file", "text/plain", 13)
			if operations[0] == "delete" {
				planAttachmentDelete(firstMock, p, task, before)
			} else {
				planAttachmentPut(firstMock, p, task, after, false)
			}
			observed := &observedAttachmentStorage{Storage: first, reached: make(chan struct{}), release: make(chan struct{})}
			a := NewAttachments(firstMock, firstMock, observed)
			b := NewAttachments(secondMock, secondMock, second)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			var once sync.Once
			release := func() { once.Do(func() { close(observed.release) }) }
			firstDone, secondDone := make(chan struct{}), make(chan struct{})
			firstResult, secondResult := make(chan error, 1), make(chan error, 1)
			secondStarted := false
			defer func() {
				cancel()
				release()
				select {
				case <-firstDone:
				case <-time.After(time.Second):
					t.Error("first mutation did not drain")
				}
				if secondStarted {
					select {
					case <-secondDone:
					case <-time.After(time.Second):
						t.Error("second operation did not drain")
					}
				}
			}()
			go func() { defer close(firstDone); firstResult <- attachmentMutation(ctx, a, p, task, operations[0]) }()
			select {
			case <-observed.reached:
			case err := <-firstResult:
				t.Fatalf("first mutation did not reach file effect: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if operations[0] == "put" && operations[1] == "put" {
				secondMock.read(p, task)
			} else if operations[1] == "put" {
				planAttachmentPut(secondMock, p, task, next, true)
			} else if operations[1] == "delete" {
				planAttachmentDelete(secondMock, p, task, after)
			} else {
				planAttachmentOpen(secondMock, p, task, after)
			}
			started := make(chan struct{})
			secondStarted = true
			go func() {
				defer close(secondDone)
				close(started)
				if operations[1] == "put" {
					_, _, err := b.Put(ctx, p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("second-writer"))
					secondResult <- err
					return
				}
				if operations[1] == "delete" {
					secondResult <- b.Delete(ctx, p, task.ProjectID, task.ID, "file")
					return
				}
				metadata, object, err := b.Open(ctx, p, task.ProjectID, task.ID, "file")
				if err != nil {
					secondResult <- err
					return
				}
				body, readErr := io.ReadAll(object.Body)
				if err := errors.Join(readErr, object.Body.Close()); err != nil || string(body) != "after" || metadata.SizeBytes != int64(len(body)) || metadata.ContentType != "text/plain" {
					secondResult <- fmt.Errorf("mismatched open: %#v %q %v", metadata, body, err)
					return
				}
				secondResult <- nil
			}()
			<-started
			if operations[0] == "put" && operations[1] == "put" {
				requireFault(t, attachmentWaitResult(t, ctx, secondResult), "resource_busy")
			} else {
				select {
				case err := <-secondResult:
					t.Fatalf("second operation passed live writer: %v", err)
				case <-time.After(100 * time.Millisecond):
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			release()
			if err := attachmentWaitResult(t, ctx, firstResult); err != nil {
				t.Fatal(err)
			}
			if operations[0] == "put" && operations[1] == "put" {
				planAttachmentPut(secondMock, p, task, next, false)
				if _, _, err := b.Put(ctx, p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("second-writer")); err != nil {
					t.Fatal(err)
				}
			} else if err := attachmentWaitResult(t, ctx, secondResult); err != nil {
				t.Fatal(err)
			}
			content := "after"
			if operations[1] == "put" {
				content = "second-writer"
			}
			object, fileErr := second.Open(ctx, attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
			if operations[1] == "delete" {
				if !errors.Is(fileErr, fs.ErrNotExist) {
					if fileErr == nil {
						object.Body.Close()
					}
					t.Fatalf("delete file result: %v", fileErr)
				}
			} else {
				if fileErr != nil {
					t.Fatal(fileErr)
				}
				body, readErr := io.ReadAll(object.Body)
				if err := errors.Join(readErr, object.Body.Close()); err != nil || string(body) != content {
					t.Fatalf("final file: %q %v", body, err)
				}
			}
			body, err := io.ReadAll(old.Body)
			if err != nil || string(body) != "before" {
				t.Fatalf("old handle: %q %v", body, err)
			}
		})
	}
}

type pausedAttachmentCompletion struct {
	inner   store.AttachmentMutationWriter
	reached chan struct{}
	release chan struct{}
	cause   error
}

func (w pausedAttachmentCompletion) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	completion, err := w.inner.WriteAttachmentMutation(ctx, fn)
	if err != nil {
		return completion, err
	}
	close(w.reached)
	select {
	case <-w.release:
	case <-ctx.Done():
		return store.Completion{Outcome: store.TransactionUnknown}, ctx.Err()
	}
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: w.cause}
}

func TestAttachmentGateHeldThroughFailedCompletion(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	item := attachmentItem(task, "file", "text/plain", 5)
	planAttachmentPut(m, p, task, item, true)
	writer := pausedAttachmentCompletion{inner: m, reached: make(chan struct{}), release: make(chan struct{}), cause: errors.New("commit response lost")}
	subject := NewAttachments(m, writer, files)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	var once sync.Once
	release := func() { once.Do(func() { close(writer.release) }) }
	done := make(chan struct{})
	finished := make(chan error, 1)
	go func() { defer close(done); finished <- attachmentMutation(ctx, subject, p, task, "put") }()
	defer func() {
		cancel()
		release()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("mutation did not drain")
		}
	}()
	select {
	case <-writer.reached:
	case err := <-finished:
		t.Fatalf("completion was not reached: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	blocked, cancelBlocked := context.WithTimeout(ctx, 200*time.Millisecond)
	_, _, err := subject.Open(blocked, p, task.ProjectID, task.ID, "file")
	cancelBlocked()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("open passed pending completion: %v", err)
	}
	release()
	if err := attachmentWaitResult(t, ctx, finished); !errors.Is(err, writer.cause) || !FileEffectPossible(err) {
		t.Fatalf("failed completion: %v", err)
	}
	subject = NewAttachments(m, m, files)
	final := attachmentItem(task, "file", "text/plain", 5)
	planAttachmentPut(m, p, task, final, false)
	if _, _, err := subject.Put(ctx, p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("final")); err != nil {
		t.Fatal(err)
	}
	planAttachmentOpen(m, p, task, final)
	_, object, err := subject.Open(ctx, p, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil || string(body) != "final" {
		t.Fatalf("recovered file: %q %v", body, err)
	}
}
