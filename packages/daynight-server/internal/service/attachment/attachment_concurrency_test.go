package attachment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type pausedAttachmentReader struct {
	io.Reader
	ctx     context.Context
	reached chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *pausedAttachmentReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.reached) })
	select {
	case <-r.release:
		return r.Reader.Read(p)
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	}
}

func TestAdmittedAttachmentUploadDoesNotReauthorizeStream(t *testing.T) {
	for _, overwrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("overwrite=%t", overwrite), func(t *testing.T) {
			subject, m, files, task, p := attachmentUnit(t)
			if overwrite {
				if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
					t.Fatal(err)
				}
			}
			const prefix, suffix = "before revocation\x00", "after revocation\xff\n"
			item := attachmentItem(task, "file", "application/octet-stream", int64(len(prefix+suffix)))
			if overwrite {
				item.UpdatedAt = item.CreatedAt.Add(time.Second)
			}
			planAttachmentPut(m, p, task, item, !overwrite)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			reader := &pausedAttachmentReader{Reader: strings.NewReader(suffix), ctx: ctx, reached: make(chan struct{}), release: make(chan struct{})}
			type result struct {
				item    model.Attachment
				created bool
				err     error
			}
			finished := make(chan result, 1)
			var release sync.Once
			unblock := func() { release.Do(func() { close(reader.release) }) }
			done := make(chan struct{})
			go func() {
				defer close(done)
				item, created, err := subject.Put(ctx, p, task.ProjectID, task.ID, "file", "application/octet-stream", io.MultiReader(strings.NewReader(prefix), reader))
				finished <- result{item, created, err}
			}()
			defer func() {
				cancel()
				unblock()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("attachment upload did not drain")
				}
			}()
			select {
			case <-reader.reached:
			case got := <-finished:
				t.Fatalf("upload did not stream: %v", got.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			// The later refusal is a separate lower outcome. No new authorization is
			// supplied to the stream that already passed admission.
			select {
			case got := <-finished:
				t.Fatalf("upload finished before body release: %v", got.err)
			default:
			}
			unblock()
			var got result
			select {
			case got = <-finished:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if got.err != nil || got.created == overwrite || !reflect.DeepEqual(got.item, item) {
				t.Fatalf("admitted result: %#v", got)
			}
			object, err := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(object.Body)
			if err := errors.Join(readErr, object.Body.Close()); err != nil || !bytes.Equal(body, []byte(prefix+suffix)) {
				t.Fatalf("admitted bytes: %q %v", body, err)
			}
			refused := newAttachmentMock(t)
			observed := &observedAttachmentStorage{Storage: files}
			rejected := NewAttachments(refused, refused, observed)
			refused.expect("snapshot").callback = true
			refused.expect("access", p, task.ProjectID).err = model.ErrNotFound
			refused.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
			refused.expect("authorize", p, task.ProjectID).err = model.ErrNotFound
			_, _, err = rejected.Put(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("must not replace"))
			requireFault(t, err, "not_found")
			refused.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
			refused.expect("authorize", p, task.ProjectID).err = model.ErrNotFound
			requireFault(t, rejected.Delete(t.Context(), p, task.ProjectID, task.ID, "file"), "not_found")
			refused.expect("snapshot").callback = true
			refused.expect("access", p, task.ProjectID).err = model.ErrNotFound
			_, _, err = rejected.Open(t.Context(), p, task.ProjectID, task.ID, "file")
			requireFault(t, err, "not_found")
			if observed.calls.Load() != 0 {
				t.Fatal("refused operation reached file storage")
			}
		})
	}
}

type observedAttachmentStorage struct {
	filestorage.Storage
	calls   atomic.Int32
	reached chan struct{}
	release chan struct{}
}

func (s *observedAttachmentStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	s.calls.Add(1)
	info, err := s.Storage.Put(ctx, bucket, path, body)
	if err == nil && s.reached != nil {
		close(s.reached)
		select {
		case <-s.release:
		case <-ctx.Done():
			return filestorage.FileInfo{}, ctx.Err()
		}
	}
	return info, err
}
func (s *observedAttachmentStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	s.calls.Add(1)
	return s.Storage.Open(ctx, bucket, path)
}
func (s *observedAttachmentStorage) Delete(ctx context.Context, bucket, path string) error {
	s.calls.Add(1)
	err := s.Storage.Delete(ctx, bucket, path)
	if err == nil && s.reached != nil {
		close(s.reached)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}
func attachmentMutation(ctx context.Context, subject *Attachments, p model.Principal, task model.Task, operation string) error {
	if operation == "delete" {
		return subject.Delete(ctx, p, task.ProjectID, task.ID, "file")
	}
	_, _, err := subject.Put(ctx, p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
	return err
}
func attachmentWaitResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return nil
	}
}

func TestAttachmentMutationsUseLifecycleScope(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		t.Run(operation, func(t *testing.T) {
			_, m, files, task, p := attachmentUnit(t)
			before := attachmentItem(task, "file", "text/plain", 6)
			if operation != "put" {
				if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
					t.Fatal(err)
				}
			}
			if operation == "delete" {
				planAttachmentDelete(m, p, task, before)
			} else {
				planAttachmentPut(m, p, task, attachmentItem(task, "file", "text/plain", 5), operation == "put")
			}
			observed := &observedAttachmentStorage{Storage: files, reached: make(chan struct{}), release: make(chan struct{})}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			finished := make(chan error, 1)
			done := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(observed.release) }) }
			go func() {
				defer close(done)
				finished <- attachmentMutation(ctx, NewAttachments(m, m, observed), p, task, operation)
			}()
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
			case <-observed.reached:
			case err := <-finished:
				t.Fatalf("mutation did not enter file operation: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			m.mu.Lock()
			pending := len(m.plan)
			m.mu.Unlock()
			// Only the metadata write remains after the file effect; the scope's Task
			// lock and lifecycle/authority calls have already completed.
			if pending != 1 {
				t.Errorf("pending calls during file operation: %d", pending)
			}
			release()
			if err := attachmentWaitResult(t, ctx, finished); err != nil {
				t.Fatal(err)
			}
			if observed.calls.Load() != 1 {
				t.Fatalf("file operations=%d", observed.calls.Load())
			}
		})
	}
}

func TestTaskPresenceControlsAttachmentMutations(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		for _, deleted := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/deleted=%t", operation, deleted), func(t *testing.T) {
				_, m, files, task, p := attachmentUnit(t)
				item := attachmentItem(task, "file", "text/plain", 6)
				if operation != "put" {
					if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
						t.Fatal(err)
					}
				}
				if operation != "delete" {
					m.read(p, task)
				}
				transaction := m.expect("mutation")
				transaction.callback = true
				if !deleted {
					transaction.completion = store.Completion{Outcome: store.TransactionCommitted}
				}
				presence := store.TaskPresence{Found: true}
				if deleted {
					at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
					presence.DeletedAt = &at
				}
				m.expect("lock", task.ProjectID, task.ID).result = presence
				if operation == "delete" {
					m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
				} else {
					m.expect("live", task.ProjectID)
				}
				if !deleted {
					if operation == "delete" {
						m.metadata(task, item)
						m.expect("delete", task.ProjectID, task.ID, "file")
					} else {
						m.conflict(task, "file", false)
						m.expect("put", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: "file", ContentType: "text/plain", SizeBytes: 5}).result = attachmentPutResult{attachmentItem(task, "file", "text/plain", 5), operation == "put"}
					}
				}
				observed := &observedAttachmentStorage{Storage: files}
				err := attachmentMutation(t.Context(), NewAttachments(m, m, observed), p, task, operation)
				if deleted {
					requireFault(t, err, "task_deleted")
					if observed.calls.Load() != 0 {
						t.Fatal("deleted Task reached file storage")
					}
				} else if err != nil || observed.calls.Load() != 1 {
					t.Fatalf("live mutation: %v calls=%d", err, observed.calls.Load())
				}
			})
		}
	}
}
