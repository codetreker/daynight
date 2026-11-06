package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type closingFailureReader struct {
	io.Reader
	cause error
}

func (r closingFailureReader) Close() error { return r.cause }

func TestPutFromRetainsLifecycleAndFailureFacts(t *testing.T) {
	for _, mode := range []string{"success", "project-deleted", "task-deleted", "task-missing", "source-failure", "close-failure", "path-conflict", "project-query-failure"} {
		t.Run(mode, func(t *testing.T) {
			attachments, tasks, db, files, task, owner := attachmentService(t)
			ctx := t.Context()
			namespace := transferNamespace(t)
			permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, namespace.ID())
			if err != nil {
				t.Fatal(err)
			}
			defer permit.Close()
			path := "file"
			if mode == "path-conflict" {
				path = "parent/child"
			}
			admission, err := attachments.AdmitTransfer(ctx, owner, task.ProjectID, task.ID, path, "text/plain", namespace)
			if err != nil {
				t.Fatal(err)
			}
			defer admission.Close()
			switch mode {
			case "project-deleted":
				if err = markProjectDeleted(ctx, db, task.ProjectID); err != nil {
					t.Fatal(err)
				}
			case "task-deleted":
				if err = tasks.Delete(ctx, owner, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version}); err != nil {
					t.Fatal(err)
				}
			case "task-missing":
				if _, err = db.Pool.Exec(ctx, `DELETE FROM tasks WHERE id=$1`, task.ID); err != nil {
					t.Fatal(err)
				}
			case "path-conflict":
				if _, err = db.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'parent','text/plain',1)`, task.ProjectID, task.ID); err != nil {
					t.Fatal(err)
				}
			case "project-query-failure":
				if _, err = db.Pool.Exec(ctx, `ALTER TABLE projects RENAME TO hidden_projects`); err != nil {
					t.Fatal(err)
				}
			}
			cause := errors.New("source or close failed")
			calls := 0
			item, created, err := admission.PutFrom(ctx, func(store.AttachmentMutationScope) (io.ReadCloser, error) {
				calls++
				switch mode {
				case "source-failure":
					return nil, cause
				case "close-failure":
					return closingFailureReader{Reader: strings.NewReader("staged"), cause: cause}, nil
				default:
					return io.NopCloser(strings.NewReader("stored")), nil
				}
			})
			switch mode {
			case "success":
				if err != nil || !created || item.Path != path || item.SizeBytes != 6 || calls != 1 {
					t.Fatalf("publication: %+v %t %d %v", item, created, calls, err)
				}
				assertAttachmentState(t, ctx, db, files, task, true, "stored")
			case "source-failure", "close-failure":
				if !errors.Is(err, cause) || calls != 1 || created || FileEffectPossible(err) {
					t.Fatalf("source failure: %t %d %v", created, calls, err)
				}
			case "project-query-failure":
				if err == nil || calls != 0 || created || FileEffectPossible(err) {
					t.Fatalf("project query failure: %t %d %v", created, calls, err)
				}
			default:
				want := "not_found"
				if mode == "task-deleted" {
					want = "task_deleted"
				}
				if mode == "path-conflict" {
					want = "path_conflict"
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != want || calls != 0 || created || FileEffectPossible(err) {
					t.Fatalf("refusal %s: %t %d %v", want, created, calls, err)
				}
			}
			if _, _, err = admission.PutFrom(ctx, func(store.AttachmentMutationScope) (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader("again")), nil
			}); err == nil {
				t.Fatal("admission reused")
			}
		})
	}
}

func TestPutFromUnknownCompletionDoesNotInventReceipt(t *testing.T) {
	_, _, db, files, task, owner := attachmentService(t)
	ctx := t.Context()
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	cause := errors.New("commit response lost")
	subject := NewAttachments(db, db, files)
	admission, err := subject.AdmitTransfer(ctx, owner, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	subject.mutations = lostAttachmentCommitReceipt{inner: db, cause: cause}
	item, created, err := admission.PutFrom(ctx, func(store.AttachmentMutationScope) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("committed")), nil
	})
	var transaction *store.TransactionError
	if item.Path != "" || created || !FileEffectPossible(err) || !errors.Is(err, cause) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
		t.Fatalf("unknown result: %+v %t %v", item, created, err)
	}
	assertAttachmentState(t, ctx, db, files, task, true, "committed")
}
