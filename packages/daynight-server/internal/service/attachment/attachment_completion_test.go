package attachment

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

type lostAttachmentCommitReceipt struct {
	inner   store.AttachmentMutationWriter
	cause   error
	noError bool
}

func (w lostAttachmentCommitReceipt) WriteAttachmentMutation(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
	completion, err := w.inner.WriteAttachmentMutation(ctx, operation)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		return completion, err
	}
	if w.noError {
		return store.Completion{Outcome: store.TransactionUnknown}, nil
	}
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Cause: w.cause, Outcome: store.TransactionUnknown, CommitAttempted: true}
}

func TestAttachmentUnknownCommitDoesNotClaimSuccessOrCompensate(t *testing.T) {
	for _, operation := range []string{"put", "delete"} {
		for _, noError := range []bool{false, true} {
			name := operation
			if noError {
				name += "/unknown-without-error"
			}
			t.Run(name, func(t *testing.T) {
				attachments, _, database, files, task, principal := attachmentService(t)
				if operation == "delete" {
					putAttachment(t, attachments, principal, task, "file", "before")
				}
				cause := errors.New("commit response lost")
				writer := lostAttachmentCommitReceipt{inner: database, cause: cause, noError: noError}
				subject := NewAttachments(database, writer, files)
				var err error
				if operation == "put" {
					value, created, putErr := subject.Put(t.Context(), principal, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
					if value.Path != "" || created {
						t.Fatalf("unknown commit returned success data: %#v created=%v", value, created)
					}
					err = putErr
				} else {
					err = subject.Delete(t.Context(), principal, task.ProjectID, task.ID, "file")
				}
				var transactionError *store.TransactionError
				if !errors.As(err, &transactionError) || transactionError.Outcome != store.TransactionUnknown || (!noError && (!transactionError.CommitAttempted || !errors.Is(err, cause))) {
					t.Fatalf("unknown completion lost: %#v %v", transactionError, err)
				}
				if !FileEffectPossible(err) {
					t.Fatal("file effect was not recorded")
				}
				// The fixture committed before losing the response. The service must not guess or undo that result.
				assertAttachmentState(t, t.Context(), database, files, task, operation != "delete", "after")
			})
		}
	}
}

func TestDeleteFileEffectFact(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	missing := attachments.Delete(t.Context(), principal, task.ProjectID, task.ID, "missing")
	if FileEffectPossible(missing) {
		t.Fatalf("missing metadata reached file: %v", missing)
	}
	putAttachment(t, attachments, principal, task, "file", "before")
	sentinel := errors.New("file delete failed")
	subject := newAttachmentService(database, attachmentFaultStorage{Storage: files, delete: sentinel})
	err := subject.Delete(t.Context(), principal, task.ProjectID, task.ID, "file")
	if !errors.Is(err, sentinel) || !FileEffectPossible(err) {
		t.Fatalf("file effect or cause lost: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	subject = newAttachmentService(database, attachmentFaultStorage{Storage: files, afterDelete: cancel})
	err = subject.Delete(ctx, principal, task.ProjectID, task.ID, "file")
	var transactionError *store.TransactionError
	if !FileEffectPossible(err) || !errors.Is(err, context.Canceled) || !errors.As(err, &transactionError) || transactionError.Outcome != store.TransactionNotCommitted {
		t.Fatalf("file effect or transaction fact lost: %v", err)
	}
}

func TestAttachmentCancellationAfterFileWritePreservesRealOutcome(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	putAttachment(t, attachments, principal, task, "file", "before")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	subject := newAttachmentService(database, attachmentFaultStorage{Storage: files, afterPut: cancel})
	_, created, err := subject.Put(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
	var transactionError *store.TransactionError
	if created || !FileEffectPossible(err) || !errors.Is(err, context.Canceled) || !errors.As(err, &transactionError) || transactionError.Outcome != store.TransactionNotCommitted || transactionError.CommitAttempted {
		t.Fatalf("cancel completion lost: created=%v error=%#v %v", created, transactionError, err)
	}
	object, err := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "after" {
		t.Fatalf("physical file: %q %v %v", content, readErr, closeErr)
	}
	var size int64
	if err := database.Pool.QueryRow(t.Context(), `SELECT size_bytes FROM task_attachments WHERE task_id=$1 AND path='file'`, task.ID).Scan(&size); err != nil || size != 6 {
		t.Fatalf("metadata after rollback: %d %v", size, err)
	}
}

func TestAttachmentDeletedTaskDoesNotExposeStateWithoutAuthorization(t *testing.T) {
	attachments, tasks, database, files, task, principal := attachmentService(t)
	putAttachment(t, attachments, principal, task, "file", "before")
	stranger := testsupport.ServicePrincipal(t, database)
	if err := tasks.Delete(t.Context(), principal, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version}); err != nil {
		t.Fatal(err)
	}
	observed := &observedAttachmentStorage{Storage: files}
	subject := newAttachmentService(database, observed)
	for _, operation := range []string{"put", "delete"} {
		requireFault(t, attachmentMutation(t.Context(), subject, stranger, task, operation), "not_found")
		requireFault(t, attachmentMutation(t.Context(), subject, principal, task, operation), "task_deleted")
	}
	if observed.calls.Load() != 0 {
		t.Fatal("refused operation reached file storage")
	}
	assertAttachmentState(t, t.Context(), database, files, task, true, "before")
}
