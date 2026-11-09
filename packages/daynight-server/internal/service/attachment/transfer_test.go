package attachment

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func transferNamespace(t *testing.T) filestorage.TransferNamespace {
	t.Helper()
	n, err := filestorage.NewTransferNamespace(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return n
}
func expectTransferAdmission(m *attachmentMock, p model.Principal, task model.Task, path string) {
	m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.conflict(task, path, false)
}
func expectTransferMutation(m *attachmentMock, task model.Task, path string, completion store.Completion) *attachmentExpectation {
	e := m.mutation(task, completion)
	m.expect("live", task.ProjectID)
	m.conflict(task, path, false)
	return e
}
func expectTransferMetadata(m *attachmentMock, task model.Task, path, contentType string, size int64, item model.Attachment, created bool) *attachmentExpectation {
	e := m.expect("put", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: contentType, SizeBytes: size})
	e.result = attachmentPutResult{item, created}
	return e
}
func requireTransferContent(t *testing.T, files *local.Storage, task model.Task, path, want string) {
	t.Helper()
	object, err := files.Open(t.Context(), "task-attachments", attachmentTestStoragePath(task, path))
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != want {
		t.Fatalf("physical content: %q %v %v", data, readErr, closeErr)
	}
}
func requireTransferMissing(t *testing.T, files *local.Storage, task model.Task, path string) {
	t.Helper()
	object, err := files.Open(t.Context(), "task-attachments", attachmentTestStoragePath(task, path))
	if err == nil {
		_ = object.Body.Close()
		t.Fatal("unexpected published attachment")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("observe missing attachment: %v", err)
	}
}

func TestPutTransferUsesAdmittedIdentityAndOwnsTargetGate(t *testing.T) {
	attachments, m, files, task, member := attachmentUnit(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	expectTransferAdmission(m, member, task, "file")
	admission, err := attachments.AdmitTransfer(ctx, member, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	item := attachmentItem(task, "file", "text/plain", 8)
	expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionCommitted})
	expectTransferMetadata(m, task, "file", "text/plain", 8, item, true)
	reader := &pausedAttachmentReader{Reader: strings.NewReader("complete"), ctx: ctx, reached: make(chan struct{}), release: make(chan struct{})}
	released := false
	release := func() {
		if !released {
			released = true
			close(reader.release)
		}
	}
	defer release()
	type result struct {
		item    model.Attachment
		created bool
		err     error
	}
	finished := make(chan result, 1)
	go func() { item, created, err := admission.Put(ctx, reader); finished <- result{item, created, err} }()
	select {
	case <-reader.reached:
	case got := <-finished:
		t.Fatalf("stream did not start: %v", got.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	blocked, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	gate, err := files.AcquireGate(blocked, filestorage.TargetGate, attachmentTestStoragePath(task, "file"))
	stop()
	if gate != nil {
		_ = gate.Close()
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("admission released target gate during stream: %v", err)
	}
	release()
	select {
	case got := <-finished:
		if got.err != nil || !got.created || !reflect.DeepEqual(got.item, item) {
			t.Fatalf("admitted result: %+v", got)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, _, err := admission.Put(ctx, strings.NewReader("again")); err == nil {
		t.Fatal("admission accepted a second publication")
	}
	if err := admission.Close(); err != nil {
		t.Fatal(err)
	}
	requireTransferContent(t, files, task, "file", "complete")
	if err := files.DeleteTransferNamespace(ctx, namespace); err != nil {
		t.Fatal(err)
	}
	requireTransferContent(t, files, task, "file", "complete")
}

func TestPutTransferReportsFileEffectAfterMetadataFailure(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	if _, err := files.Put(t.Context(), "task-attachments", attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
		t.Fatal(err)
	}
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	expectTransferAdmission(m, p, task, "file")
	admission, err := attachments.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionNotCommitted})
	cause := errors.New("metadata refused")
	expectTransferMetadata(m, task, "file", "text/plain", 5, model.Attachment{}, false).err = cause
	item, created, err := admission.Put(t.Context(), strings.NewReader("after"))
	if !errors.Is(err, cause) || !FileEffectPossible(err) || created || item.Path != "" {
		t.Fatalf("missing file effect: %+v %t %v", item, created, err)
	}
	requireTransferContent(t, files, task, "file", "after")
}

type failingTransferPublisher struct {
	*local.Storage
	cause        error
	publishFirst bool
	objectID     string
}

func (s *failingTransferPublisher) PublishTransferAttachment(ctx context.Context, n filestorage.TransferNamespace, id string, target filestorage.TransferAttachmentTarget) error {
	s.objectID = id
	if s.publishFirst {
		if err := s.Storage.PublishTransferAttachment(ctx, n, id, target); err != nil {
			return err
		}
	}
	return s.cause
}
func TestPutTransferPublicationFailuresPreserveTransactionFacts(t *testing.T) {
	for _, test := range []struct {
		name         string
		cause        error
		publishFirst bool
	}{{"path conflict", filestorage.ErrPathConflict, false}, {"failure after publication", errors.New("publication sync failed"), true}} {
		t.Run(test.name, func(t *testing.T) {
			_, m, files, task, p := attachmentUnit(t)
			if _, err := files.Put(t.Context(), "task-attachments", attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
				t.Fatal(err)
			}
			publisher := &failingTransferPublisher{Storage: files, cause: test.cause, publishFirst: test.publishFirst}
			subject := NewAttachments(m, m, publisher)
			namespace := transferNamespace(t)
			private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
			if err != nil {
				t.Fatal(err)
			}
			defer private.Close()
			expectTransferAdmission(m, p, task, "file")
			admission, err := subject.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
			if err != nil {
				t.Fatal(err)
			}
			defer admission.Close()
			e := expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionNotCommitted})
			e.callbackError = func(err error) error {
				return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
			}
			item, created, err := admission.Put(t.Context(), strings.NewReader("after"))
			var transaction *store.TransactionError
			if !errors.Is(err, test.cause) || !FileEffectPossible(err) || !errors.As(err, &transaction) || transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted || transaction.CleanupFailed || created || !reflect.DeepEqual(item, model.Attachment{}) {
				t.Fatalf("publication facts: %+v %t %+v %v", item, created, transaction, err)
			}
			if !test.publishFirst {
				requireFault(t, err, "path_conflict")
			} else {
				var f *model.Fault
				if errors.As(err, &f) {
					t.Fatalf("operational failure became conflict: %v", err)
				}
			}
			want := "before"
			if test.publishFirst {
				want = "after"
			}
			requireTransferContent(t, files, task, "file", want)
			staged, err := files.OpenTransfer(t.Context(), namespace, publisher.objectID)
			if test.publishFirst {
				if err == nil {
					_ = staged.Body.Close()
					t.Fatal("published object remained staged")
				}
				if !errors.Is(err, fs.ErrNotExist) {
					t.Fatal(err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(staged.Body)
				closeErr := staged.Body.Close()
				if readErr != nil || closeErr != nil || string(data) != "after" {
					t.Fatalf("staged content: %q %v %v", data, readErr, closeErr)
				}
			}
			if err := admission.Close(); err != nil {
				t.Fatal(err)
			}
			if err := files.DeleteTransferNamespace(t.Context(), namespace); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type failedTransferReader struct{ err error }

func (r failedTransferReader) Read([]byte) (int, error) { return 0, r.err }
func TestPutTransferStageFailureDoesNotPublish(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	if _, err := files.Put(t.Context(), "task-attachments", attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
		t.Fatal(err)
	}
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	expectTransferAdmission(m, p, task, "file")
	admission, err := attachments.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionNotCommitted})
	cause := errors.New("injected input failure")
	_, _, err = admission.Put(t.Context(), failedTransferReader{cause})
	if !errors.Is(err, cause) || FileEffectPossible(err) {
		t.Fatalf("stage failure: %v", err)
	}
	requireTransferContent(t, files, task, "file", "before")
}
