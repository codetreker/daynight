package attachment

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type injectedResidencyStorage struct {
	*local.Storage
	failKey    string
	acquireErr error
	closeErr   error
}

func (s injectedResidencyStorage) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	if s.acquireErr != nil && strings.Contains(key, s.failKey) {
		return nil, s.acquireErr
	}
	permit, err := s.Storage.TryAcquireResidency(ctx, key)
	if err != nil {
		return nil, err
	}
	if s.closeErr != nil {
		return injectedCloser{Closer: permit, err: s.closeErr}, nil
	}
	return permit, nil
}

type injectedCloser struct {
	io.Closer
	err error
}

func (c injectedCloser) Close() error { return errors.Join(c.Closer.Close(), c.err) }

func TestUploadLeaseAcquireFailureReleasesPartialPermits(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	user := model.Principal{UserID: uuid.NewString()}
	project, task := uuid.NewString(), uuid.NewString()
	cause, cleanup := errors.New("gate unavailable"), errors.New("close failed")
	for _, test := range []struct {
		name, key string
		cause     error
		busy      bool
	}{
		{"user error", "/user/", cause, false},
		{"task error", "/task/", cause, false},
		{"user busy", "/user/", filestorage.ErrGateBusy, true},
		{"task busy", "/task/", filestorage.ErrGateBusy, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			subject := NewAttachments(poolCapacity{max: 1}, nil, injectedResidencyStorage{Storage: files, failKey: test.key, acquireErr: test.cause, closeErr: cleanup})
			permit, err := subject.AcquireUploadLease(t.Context(), user, project, task)
			if permit != nil {
				t.Fatal("failed acquisition returned permit")
			}
			if test.busy {
				requireFault(t, err, "resource_busy")
			} else if !errors.Is(err, cause) {
				t.Fatalf("cause lost: %v", err)
			}
			if test.key == "/task/" && !errors.Is(err, cleanup) {
				t.Fatalf("cleanup cause lost: %v", err)
			}
			if len(subject.uploadSlots) != 0 {
				t.Fatal("instance slot retained")
			}
			probe := NewAttachments(poolCapacity{max: 1}, nil, files)
			lease, err := probe.AcquireUploadLease(t.Context(), user, project, task)
			if err != nil {
				t.Fatalf("partial permits retained: %v", err)
			}
			if err := lease.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
	subject := NewAttachments(poolCapacity{max: 1}, nil, files)
	for _, args := range []struct {
		user          model.Principal
		project, task string
	}{
		{model.Principal{UserID: "bad"}, project, task}, {user, "bad", task}, {user, project, "bad"},
	} {
		if _, err := subject.AcquireUploadLease(t.Context(), args.user, args.project, args.task); err == nil {
			t.Fatal("invalid identity accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	subject.uploadSlots <- struct{}{}
	if _, err := subject.AcquireUploadLease(ctx, user, project, task); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
	_, err = subject.AcquireUploadLease(t.Context(), user, project, task)
	requireFault(t, err, "resource_busy")
	<-subject.uploadSlots
}

func TestPutLeaseCleanupAndRetention(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	closeFailure := errors.New("lease close failed")
	subject := m.service(m, injectedResidencyStorage{Storage: files, closeErr: closeFailure})
	planAttachmentPut(m, p, task, attachmentItem(task, "file", "text/plain", 5), true)
	item, created, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("saved"))
	var transaction *store.TransactionError
	if !created || item.Path != "file" || !errors.Is(err, closeFailure) || !FileEffectPossible(err) || filestorage.PublicationOutcome(err) != filestorage.Published || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionCommitted || !transaction.CleanupFailed {
		t.Fatalf("committed cleanup: %+v %t %v", item, created, err)
	}
	requireTransferContent(t, files, task, "file", "saved")
	m.read(p, task)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("live", task.ProjectID)
	m.conflict(task, "bad", false)
	_, _, err = subject.Put(t.Context(), p, task.ProjectID, task.ID, "bad", "text/plain", strings.NewReader(strings.Repeat("x", 5242881)))
	if !errors.Is(err, closeFailure) || FileEffectPossible(err) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("prepublication cleanup: %v", err)
	}
	requireFault(t, err, "payload_too_large")
	var held io.Closer
	ctx := WithUploadLeaseRetainer(t.Context(), func(lease io.Closer) { held = lease })
	planAttachmentPut(m, p, task, attachmentItem(task, "retained", "text/plain", 2), true)
	_, _, err = subject.Put(ctx, p, task.ProjectID, task.ID, "retained", "text/plain", strings.NewReader("ok"))
	if err != nil || held == nil {
		t.Fatalf("retained result: %v", err)
	}
	_, err = subject.AcquireUploadLease(t.Context(), p, task.ProjectID, task.ID)
	requireFault(t, err, "resource_busy")
	if err := held.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("retained cleanup: %v", err)
	}
	lease, err := subject.AcquireUploadLease(t.Context(), p, task.ProjectID, task.ID)
	if err != nil {
		t.Fatalf("slot not released: %v", err)
	}
	_ = lease.Close()
}

func TestTransferPutFromLeaseCleanupAndRetention(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	closeFailure := errors.New("lease close failed")
	subject := m.service(m, injectedResidencyStorage{Storage: files, closeErr: closeFailure})
	source := func(store.AttachmentMutationScope) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("saved")), nil
	}
	for _, retain := range []bool{false, true} {
		namespace := transferNamespace(t)
		private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
		if err != nil {
			t.Fatal(err)
		}
		expectTransferAdmission(m, p, task, "file")
		admission, err := subject.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", namespace)
		if err != nil {
			t.Fatal(err)
		}
		var held io.Closer
		ctx := t.Context()
		if retain {
			ctx = WithUploadLeaseRetainer(ctx, func(lease io.Closer) { held = lease })
		}
		expectTransferMutation(m, task, "file", store.Completion{Outcome: store.TransactionCommitted})
		expectTransferMetadata(m, task, "file", "text/plain", 5, attachmentItem(task, "file", "text/plain", 5), !retain)
		item, _, err := admission.PutFrom(ctx, source)
		if retain {
			if err != nil || held == nil {
				t.Fatalf("retained transfer: %v", err)
			}
			if err := held.Close(); !errors.Is(err, closeFailure) {
				t.Fatalf("retained cleanup: %v", err)
			}
		} else {
			var transaction *store.TransactionError
			if !errors.Is(err, closeFailure) || !FileEffectPossible(err) || filestorage.PublicationOutcome(err) != filestorage.Published || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionCommitted || !transaction.CleanupFailed {
				t.Fatalf("transfer cleanup: %+v %v", item, err)
			}
		}
		if err := admission.Close(); err != nil {
			t.Fatal(err)
		}
		if err := private.Close(); err != nil {
			t.Fatal(err)
		}
	}
	namespace := transferNamespace(t)
	private, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	expectTransferAdmission(m, p, task, "failure")
	admission, err := subject.AdmitTransfer(t.Context(), p, task.ProjectID, task.ID, "failure", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	expectTransferMutation(m, task, "failure", store.Completion{Outcome: store.TransactionNotCommitted})
	sourceFailure := errors.New("source failed")
	_, _, err = admission.PutFrom(t.Context(), func(store.AttachmentMutationScope) (io.ReadCloser, error) { return nil, sourceFailure })
	if !errors.Is(err, sourceFailure) || !errors.Is(err, closeFailure) || FileEffectPossible(err) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("source cleanup: %v", err)
	}
}
