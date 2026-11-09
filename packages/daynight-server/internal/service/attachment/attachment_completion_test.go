package attachment

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentUnknownCommitDoesNotClaimSuccessOrCompensate(t *testing.T) {
	for _, operation := range []string{"put", "delete"} {
		for _, noError := range []bool{false, true} {
			name := operation
			if noError {
				name += "/unknown-without-error"
			}
			t.Run(name, func(t *testing.T) {
				subject, m, files, task, p := attachmentUnit(t)
				item := attachmentItem(task, "file", "text/plain", 5)
				if operation == "delete" {
					if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
						t.Fatal(err)
					}
				} else {
					m.read(p, task)
				}
				cause := errors.New("commit response lost")
				completion := m.expect("mutation")
				completion.callback = true
				completion.completion = store.Completion{Outcome: store.TransactionUnknown}
				if !noError {
					completion.err = &store.TransactionError{Phase: "commit", Cause: cause, Outcome: store.TransactionUnknown, CommitAttempted: true}
				}
				m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
				if operation == "put" {
					m.put(task, "file", "text/plain", 5, item, true)
				} else {
					m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
					m.metadata(task, item)
					m.expect("metadataDelete", task.ProjectID, task.ID, "file")
				}
				var err error
				if operation == "put" {
					got, created, putErr := subject.Put(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
					if got.Path != "" || created {
						t.Fatalf("unknown commit returned success data: %#v created=%v", got, created)
					}
					err = putErr
				} else {
					err = subject.Delete(t.Context(), p, task.ProjectID, task.ID, "file")
				}
				var failure *store.TransactionError
				if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || (!noError && (!failure.CommitAttempted || !errors.Is(err, cause))) || !FileEffectPossible(err) {
					t.Fatalf("unknown completion lost: %#v %v", failure, err)
				}
				object, fileErr := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
				if operation == "delete" {
					if !errors.Is(fileErr, fs.ErrNotExist) {
						if fileErr == nil {
							_ = object.Body.Close()
						}
						t.Fatalf("unknown delete was compensated: %v", fileErr)
					}
				} else {
					if fileErr != nil {
						t.Fatal(fileErr)
					}
					body, readErr := io.ReadAll(object.Body)
					if err := errors.Join(readErr, object.Body.Close()); err != nil || string(body) != "after" {
						t.Fatalf("unknown put was compensated: %q %v", body, err)
					}
				}
			})
		}
	}
}

func TestDeleteFileEffectFact(t *testing.T) {
	subject, m, files, task, p := attachmentUnit(t)
	missing := attachmentItem(task, "missing", "text/plain", 0)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.metadata(task, missing).err = attachmentNotFound()
	if err := subject.Delete(t.Context(), p, task.ProjectID, task.ID, "missing"); FileEffectPossible(err) {
		t.Fatalf("missing metadata reached file: %v", err)
	} else {
		requireFault(t, err, "not_found")
	}
	item := attachmentItem(task, "file", "text/plain", 6)
	sentinel := errors.New("file delete failed")
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.metadata(task, item)
	failed := m.service(m, attachmentFaultStorage{Storage: files, delete: sentinel})
	if err := failed.Delete(t.Context(), p, task.ProjectID, task.ID, "file"); !errors.Is(err, sentinel) || !FileEffectPossible(err) {
		t.Fatalf("file effect or cause lost: %v", err)
	}
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	transaction := m.expect("mutation")
	transaction.callback = true
	transaction.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	transaction.callbackError = func(err error) error {
		return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.metadata(task, item)
	e := m.expect("metadataDelete", task.ProjectID, task.ID, "file")
	e.ctx = ctx
	e.err = context.Canceled
	e.after = func() {
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Error("metadata delete did not receive cancellation")
		}
	}
	failed = m.service(m, attachmentFaultStorage{Storage: files, afterDelete: cancel})
	err := failed.Delete(ctx, p, task.ProjectID, task.ID, "file")
	var failure *store.TransactionError
	if !FileEffectPossible(err) || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
		t.Fatalf("file effect or transaction fact lost: %v", err)
	}
}

func TestAttachmentCancellationAfterFileWritePreservesCompletion(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	m.read(p, task)
	transaction := m.expect("mutation")
	transaction.callback = true
	transaction.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	transaction.callbackError = func(err error) error {
		return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
	m.expect("live", task.ProjectID)
	m.conflict(task, "file", false)
	e := m.expect("metadataPut", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: "file", ContentType: "text/plain", SizeBytes: 5})
	e.ctx = ctx
	e.err = context.Canceled
	e.after = func() {
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Error("metadata write did not receive cancellation")
		}
	}
	subject := m.service(m, attachmentFaultStorage{Storage: files, afterPut: cancel})
	item, created, err := subject.Put(ctx, p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
	var failure *store.TransactionError
	if item.Path != "" || created || !FileEffectPossible(err) || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("cancel completion lost: %#v created=%v error=%#v %v", item, created, failure, err)
	}
	object, err := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil || string(body) != "after" {
		t.Fatalf("physical file: %q %v", body, err)
	}
}

func TestAttachmentDeletedTaskDoesNotExposeStateWithoutAuthorization(t *testing.T) {
	for _, operation := range []string{"put", "delete"} {
		for _, authorized := range []bool{false, true} {
			name := operation + "/outsider"
			if authorized {
				name = operation + "/owner"
			}
			t.Run(name, func(t *testing.T) {
				_, m, files, task, p := attachmentUnit(t)
				if !authorized {
					p.UserID = "ef000000-0000-4000-8000-000000000003"
				}
				deleted := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
				if operation == "put" {
					m.expect("snapshot").callback = true
					access := m.expect("projectRead", p, task.ProjectID)
					access.result = model.ProjectAccess{ProjectID: task.ProjectID}
					if authorized {
						m.expect("presence", task.ProjectID, task.ID).result = store.TaskPresence{Found: true, DeletedAt: &deleted}
					} else {
						access.err = projectReadNotFound()
					}
				}
				m.expect("mutation").callback = true
				m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true, DeletedAt: &deleted}
				access := m.expect("authorize", p, task.ProjectID)
				access.result = model.ProjectAccess{}
				if !authorized {
					access.err = model.ErrNotFound
				}
				observed := &observedAttachmentStorage{Storage: files}
				err := attachmentMutation(t.Context(), m.service(m, observed), p, task, operation)
				code := "not_found"
				if authorized {
					code = "task_deleted"
				}
				requireFault(t, err, code)
				if observed.calls.Load() != 0 {
					t.Fatal("refused operation reached file storage")
				}
			})
		}
	}
}
