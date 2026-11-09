package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type storageTimeout struct{}

func (storageTimeout) Error() string   { return "socket read timeout" }
func (storageTimeout) Timeout() bool   { return true }
func (storageTimeout) Temporary() bool { return true }

type storageTimeoutReader struct {
	cancel context.CancelFunc
	before func() error
}

func (r storageTimeoutReader) Read([]byte) (int, error) {
	if r.before != nil {
		if err := r.before(); err != nil {
			return 0, err
		}
	}
	r.cancel()
	return 0, storageTimeout{}
}
func (storageTimeoutReader) Close() error { return nil }

func storageReadFailure(t *testing.T, before func(root string) error) error {
	t.Helper()
	root := t.TempDir()
	storage, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := httptest.NewRequest(http.MethodPut, "/", nil).WithContext(ctx)
	r.Body = storageTimeoutReader{cancel: cancel, before: func() error {
		if before != nil {
			return before(root)
		}
		return nil
	}}
	reader := NewDeadlineBody(httptest.NewRecorder(), r, 0)
	_, err = storage.Put(ctx, "bucket", "dir/file", reader)
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected timeout and cancellation: %v", err)
	}
	var body *BodyReadError
	if !errors.As(err, &body) || body.Status != http.StatusRequestTimeout {
		t.Fatalf("timeout missing from storage failure: %v", err)
	}
	return err
}

func TestDeadlineBodyStorageErrorClassification(t *testing.T) {
	err := storageReadFailure(t, nil)
	if got := bodyReadFailure(err); got == nil || got.Status != http.StatusRequestTimeout {
		t.Fatalf("cleaned up read timeout lost in storage errors: %v", err)
	}
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"cleanup", errors.Join(err, errors.New("cleanup failed"))},
		{"rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: err}},
		{"unknown commit", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: err}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := bodyReadFailure(tc.err); got != nil {
				t.Fatalf("%s was hidden by timeout: %v", tc.name, got)
			}
		})
	}
}

func TestAttachmentOverflowStorageErrorClassification(t *testing.T) {
	storage, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	_, overflow := storage.Put(t.Context(), "bucket", "file", attachmentcore.BoundedContent(strings.NewReader(strings.Repeat("x", int(attachmentcore.MaxFileBytes)+1))))
	var marker *attachmentcore.ContentOverflowError
	if !errors.As(overflow, &marker) || filestorage.PublicationOutcome(overflow) != filestorage.NotPublished {
		t.Fatalf("actual storage overflow lost refusal or publication: %v", overflow)
	}
	for _, tc := range []struct {
		name    string
		err     error
		refusal bool
	}{
		{"cleaned up storage", overflow, true},
		{"rolled back operation", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: overflow}, true},
		{"thread rollback", &store.ThreadTransactionError{Phase: "operation", Cause: overflow}, true},
		{"published", &filestorage.PublicationError{Outcome: filestorage.Published, Cause: overflow}, false},
		{"publication unknown", &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: overflow}, false},
		{"invalid publication", &filestorage.PublicationError{Cause: overflow}, false},
		{"nested unknown publication", &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: overflow}}, false},
		{"cleanup", errors.Join(overflow, errors.New("cleanup failed")), false},
		{"canceled operation", errors.Join(overflow, context.Canceled), false},
		{"deadline without read timeout", errors.Join(overflow, context.DeadlineExceeded), false},
		{"rollback failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: overflow}, false},
		{"database failure", &store.Error{Phase: "operation", DatabaseFailure: true, Cause: overflow}, false},
		{"commit attempted", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: overflow}, false},
		{"unknown commit", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: overflow}, false},
		{"committed", &store.TransactionError{Phase: "operation", Outcome: store.TransactionCommitted, Cause: overflow}, false},
		{"thread rollback failed", &store.ThreadTransactionError{Phase: "operation", RollbackFailed: true, Cause: overflow}, false},
		{"thread commit attempted", &store.ThreadTransactionError{Phase: "operation", CommitAttempted: true, Cause: overflow}, false},
		{"thread outcome unknown", &store.ThreadTransactionError{Phase: "operation", OutcomeUnknown: true, Cause: overflow}, false},
		{"generic byte fault", attachmentcore.FileTooLarge(), false},
		{"generic input fault", &model.Fault{Code: "invalid_input", Message: "invalid input"}, false},
		{"no terminal evidence", &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: errors.New("write failed")}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := bodyReadFailure(tc.err)
			if (failure != nil) != tc.refusal {
				t.Fatalf("terminal refusal=%v want=%v: %v", failure, tc.refusal, tc.err)
			}
			if failure != nil && (failure.Status != http.StatusRequestEntityTooLarge || failure.Code != "payload_too_large" || !errors.Is(failure, marker)) {
				t.Fatalf("overflow classification lost original cause: %v", failure)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			r := httptest.NewRequest(http.MethodPut, "/", nil).WithContext(ctx)
			w := httptest.NewRecorder()
			WriteBodyError(w, r, quietLogger(), "attachment", "put", tc.err)
			if tc.refusal {
				if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), `"code":"payload_too_large"`) {
					t.Fatalf("terminal refusal suppressed: %d %s", w.Code, w.Body)
				}
			} else if w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" {
				t.Fatalf("uncertain or ordinary failure detached cancellation: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestDeadlineBodyStorageCleanupFailureIsNotTimeout(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("requires Unix directory permissions without root privileges")
	}
	err := storageReadFailure(t, func(root string) error {
		dir := filepath.Join(root, "bucket", "dir")
		t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
		return os.Chmod(dir, 0500)
	})
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("expected actual failed cleanup: %v", err)
	}
	if got := bodyReadFailure(err); got != nil {
		t.Fatalf("actual cleanup failure hidden by timeout: %v", got)
	}
}

var _ io.ReadCloser = storageTimeoutReader{}
