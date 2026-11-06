package mcptransfer

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAdmittedUploadRejectsMissingClosedAndWrongBinding(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	ctx := t.Context()
	if _, err := f.lifecycle.admittedUploadRecord(ctx, nil); !errors.Is(err, ErrState) {
		t.Fatalf("nil permit: %v", err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, &Permit{}); !errors.Is(err, ErrState) {
		t.Fatalf("foreign permit: %v", err)
	}
	p, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	original := p.actor
	p.actor.AuthorityID = uuid.NewString()
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong binding: %v", err)
	}
	p.actor = original
	if _, err := f.db.Pool.Exec(ctx, `UPDATE private_transfers SET direction='download' WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong direction: %v", err)
	}
	if _, err := f.db.Pool.Exec(ctx, `DELETE FROM private_transfers WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted transfer: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, ErrState) {
		t.Fatalf("closed permit: %v", err)
	}
}

func TestReserveAdmittedUploadRejectsCapacityAndCleanup(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	ctx := t.Context()
	p, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, -1); !errors.Is(err, ErrState) {
		t.Fatalf("negative reservation: %v", err)
	}
	private := f.lifecycle.private
	defer func() { f.lifecycle.private = private }()
	f.lifecycle.reservedFree = 10
	for _, tc := range []struct{ free, bytes int64 }{{9, 1}, {11, 2}} {
		f.lifecycle.private = constrainedStorage{TransferStorage: private, free: tc.free}
		if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, tc.bytes); !errors.Is(err, ErrCapacity) {
			t.Fatalf("insufficient disk capacity: %v", err)
		}
	}
	diskErr := errors.New("disk space unavailable")
	f.lifecycle.private = constrainedStorage{TransferStorage: private, err: diskErr}
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, diskErr) {
		t.Fatalf("disk sampling failure: %v", err)
	}
	f.lifecycle.private = constrainedStorage{TransferStorage: private, free: 100}
	f.lifecycle.budget = 1
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 2); err == nil {
		t.Fatal("shared budget exceeded")
	}
	if _, err := f.lifecycle.RequestCleanup(ctx, f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, ErrState) {
		t.Fatalf("cleanup barrier: %v", err)
	}
}

type admittedFaultWriter struct {
	inner store.PrivateTransferWriter
	phase string
	cause error
}

type admittedFaultDAO struct {
	store.PrivateTransferDAO
	phase string
	cause error
}

func (d admittedFaultDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	if d.phase == "get" {
		return model.PrivateTransfer{}, d.cause
	}
	return d.PrivateTransferDAO.Get(ctx, id)
}
func (d admittedFaultDAO) LockLedger(ctx context.Context) error {
	if d.phase == "lock" {
		return d.cause
	}
	return d.PrivateTransferDAO.LockLedger(ctx)
}
func (d admittedFaultDAO) OutstandingTotal(ctx context.Context) (int64, error) {
	if d.phase == "total" {
		return 0, d.cause
	}
	return d.PrivateTransferDAO.OutstandingTotal(ctx)
}
func (w admittedFaultWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.inner.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return fn(admittedFaultDAO{d, w.phase, w.cause}) })
}

func TestAdmittedUploadDatabaseFailuresPreserveCapacity(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	p, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	inner := f.lifecycle.db
	defer func() { f.lifecycle.db = inner }()
	for _, phase := range []string{"get", "lock", "total"} {
		cause := errors.New("injected " + phase + " failure")
		f.lifecycle.db = admittedFaultWriter{inner: inner, phase: phase, cause: cause}
		if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, cause) {
			t.Fatalf("%s failure: %v", phase, err)
		}
	}
	f.lifecycle.db = inner
	current, err := f.lifecycle.LookupBound(ctx, f.actor, r.ID)
	if err != nil || current.ReservedBytes != 0 || current.OutstandingBytes != 0 {
		t.Fatalf("failed reservation changed accounting: %+v %v", current, err)
	}
}
