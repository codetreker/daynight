package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type closingFailureReader struct {
	io.Reader
	cause  error
	closes *int
}

func (r closingFailureReader) Close() error {
	if r.closes != nil {
		*r.closes++
	}
	return r.cause
}

func TestPutFromRetainsLifecycleAndFailureFacts(t *testing.T) {
	for _, mode := range []string{"success", "project-deleted", "task-deleted", "task-missing", "source-failure", "close-failure", "path-conflict", "project-query-failure"} {
		t.Run(mode, func(t *testing.T) {
			attachments, m, files, task, p := attachmentUnit(t)
			namespace := transferNamespace(t)
			private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
			if err != nil {
				t.Fatal(err)
			}
			defer private.Close()
			path := "file"
			if mode == "path-conflict" {
				path = "parent/child"
			}
			expectTransferAdmission(m, p, task, path)
			admission, err := attachments.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, path, "text/plain", namespace)
			if err != nil {
				t.Fatal(err)
			}
			defer admission.Close()
			completion := store.Completion{Outcome: store.TransactionNotCommitted}
			if mode == "success" {
				completion.Outcome = store.TransactionCommitted
			}
			e := m.expect("mutation")
			e.callback = true
			e.completion = completion
			presence := store.TaskPresence{Found: true}
			if mode == "task-missing" {
				presence = store.TaskPresence{}
			}
			if mode == "task-deleted" {
				presence.DeletedAt = pointer(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
			}
			m.expect("lock", task.ProjectID, task.ID).result = presence
			cause := errors.New("source or close failed")
			switch mode {
			case "task-deleted", "task-missing":
				m.expect("live", task.ProjectID)
			case "project-deleted":
				m.expect("live", task.ProjectID).err = model.ErrNotFound
			case "project-query-failure":
				m.expect("live", task.ProjectID).err = cause
			default:
				m.expect("live", task.ProjectID)
				m.conflict(task, path, mode == "path-conflict")
				if mode == "success" {
					expectTransferMetadata(m, task, path, "text/plain", 6, attachmentItem(task, path, "text/plain", 6), true)
				}
			}
			calls, closes := 0, 0
			item, created, err := admission.PutFrom(t.Context(), func(scope store.AttachmentMutationScope) (io.ReadCloser, error) {
				calls++
				if scope != m {
					t.Errorf("source received different mutation scope: %T", scope)
				}
				switch mode {
				case "source-failure":
					return nil, cause
				case "close-failure":
					return closingFailureReader{Reader: strings.NewReader("staged"), cause: cause, closes: &closes}, nil
				default:
					return closingFailureReader{Reader: strings.NewReader("stored"), closes: &closes}, nil
				}
			})
			switch mode {
			case "success":
				if err != nil || !created || item.Path != path || item.SizeBytes != 6 || calls != 1 || closes != 1 {
					t.Fatalf("publication: %+v %t calls=%d closes=%d %v", item, created, calls, closes, err)
				}
				requireTransferContent(t, files, task, path, "stored")
			case "source-failure", "close-failure":
				wantClose := 0
				if mode == "close-failure" {
					wantClose = 1
				}
				if !errors.Is(err, cause) || calls != 1 || closes != wantClose || created || FileEffectPossible(err) {
					t.Fatalf("source failure: %t calls=%d closes=%d %v", created, calls, closes, err)
				}
				requireTransferMissing(t, files, task, path)
			case "project-query-failure":
				if !errors.Is(err, cause) || calls != 0 || created || FileEffectPossible(err) {
					t.Fatalf("query failure: %t %d %v", created, calls, err)
				}
			default:
				want := "not_found"
				if mode == "task-deleted" {
					want = "task_deleted"
				}
				if mode == "path-conflict" {
					want = "path_conflict"
				}
				requireFault(t, err, want)
				if calls != 0 || created || FileEffectPossible(err) {
					t.Fatalf("refusal: %t %d %v", created, calls, err)
				}
			}
			if _, _, err := admission.PutFrom(t.Context(), func(store.AttachmentMutationScope) (io.ReadCloser, error) {
				t.Error("reused admission called source")
				return io.NopCloser(strings.NewReader("again")), nil
			}); err == nil {
				t.Fatal("admission reused")
			}
		})
	}
}

func TestPutFromUnknownCompletionDoesNotInventReceipt(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	namespace := transferNamespace(t)
	private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	expectTransferAdmission(m, p, task, "file")
	admission, err := attachments.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	cause := errors.New("commit response lost")
	e := expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionUnknown})
	e.err = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
	expectTransferMetadata(m, task, "file", "text/plain", 9, attachmentItem(task, "file", "text/plain", 9), true)
	item, created, err := admission.PutFrom(t.Context(), func(store.AttachmentMutationScope) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("committed")), nil
	})
	var transaction *store.TransactionError
	if item.Path != "" || created || !FileEffectPossible(err) || !errors.Is(err, cause) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
		t.Fatalf("unknown result: %+v %t %v", item, created, err)
	}
	requireTransferContent(t, files, task, "file", "committed")
}
