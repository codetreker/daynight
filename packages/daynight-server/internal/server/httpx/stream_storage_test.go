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
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
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
