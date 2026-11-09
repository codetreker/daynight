package mcptransfer

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func admittedPermit(t *testing.T, f lifecycleFixture, before model.PrivateTransfer) (*Permit, model.PrivateTransfer) {
	t.Helper()
	renewed := cloneTransfer(before)
	renewed.Version++
	f.expect(get(before), auth(f.actor, before, nil), get(before), daoStep{
		method: "Put", result: cloneTransfer(renewed),
		check: func(args []any) {
			proposed := args[0].(model.PrivateTransfer)
			expected := cloneTransfer(before)
			expected.ExpiresAt = proposed.ExpiresAt
			if args[1] != before.Version || !reflect.DeepEqual(proposed, expected) || !proposed.ExpiresAt.After(time.Now()) || proposed.ExpiresAt.After(before.HardExpiresAt) {
				t.Errorf("permit renewal: proposed=%+v version=%v", proposed, args[1])
			}
		},
	})
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, before.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Error(err)
		}
	})
	return p, renewed
}

func TestAdmittedUploadRejectsMissingClosedAndWrongBinding(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	if _, err := f.lifecycle.admittedUploadRecord(ctx, nil); !errors.Is(err, transfer.ErrState) {
		t.Fatalf("nil permit: %v", err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, &Permit{}); !errors.Is(err, transfer.ErrState) {
		t.Fatalf("foreign permit: %v", err)
	}
	p, current := admittedPermit(t, f, f.record())
	original := p.actor
	p.actor.AuthorityID = uuid.NewString()
	f.expect(get(current))
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, transfer.ErrConflict) {
		t.Fatalf("wrong binding: %v", err)
	}
	p.actor = original
	download := cloneTransfer(current)
	download.Direction = "download"
	f.expect(get(download))
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, transfer.ErrConflict) {
		t.Fatalf("wrong direction: %v", err)
	}
	f.expect(getMissing(current.ID))
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted transfer: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.admittedUploadRecord(ctx, p); !errors.Is(err, transfer.ErrState) {
		t.Fatalf("closed permit: %v", err)
	}
}

func TestReserveAdmittedUploadRejectsCapacityAndCleanup(t *testing.T) {
	f := newFixture(t)
	p, current := admittedPermit(t, f, f.record())
	ctx := t.Context()
	project := func() daoStep {
		return method("LockProjectLifecycle", nil, nil, current.ProjectID, current.TaskID)
	}
	f.expect(get(current), project())
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, -1); !errors.Is(err, transfer.ErrState) {
		t.Fatalf("negative reservation: %v", err)
	}
	private := f.lifecycle.private
	f.lifecycle.reservedFree = 10
	for _, tc := range []struct{ free, bytes int64 }{{9, 1}, {11, 2}} {
		f.lifecycle.private = constrainedStorage{TransferStorage: private, free: tc.free}
		f.expect(get(current), project(), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil))
		if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, tc.bytes); !errors.Is(err, transfer.ErrCapacity) {
			t.Fatalf("insufficient disk capacity: %v", err)
		}
	}
	diskErr := errors.New("disk space unavailable")
	f.lifecycle.private = constrainedStorage{TransferStorage: private, err: diskErr}
	f.expect(get(current), project(), method("LockLedger", nil, nil))
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, diskErr) {
		t.Fatalf("disk sampling failure: %v", err)
	}
	f.lifecycle.private = constrainedStorage{TransferStorage: private, free: 100}
	f.lifecycle.budget = 1
	f.expect(get(current), project(), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil), get(current), method("LockLedger", nil, nil), method("ReservedTotal", int64(0), nil))
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 2); err == nil {
		t.Fatal("shared budget exceeded")
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "capacity_unavailable" {
			t.Fatalf("shared budget failure: %v", err)
		}
	}
	pending := cloneTransfer(current)
	pending.State = "cleanup_pending"
	f.expect(get(pending), project())
	if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, transfer.ErrState) {
		t.Fatalf("cleanup barrier: %v", err)
	}
}

func TestAdmittedUploadDatabaseFailuresPreserveCapacity(t *testing.T) {
	f := newFixture(t)
	p, current := admittedPermit(t, f, f.record())
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	for _, phase := range []string{"get", "lock", "total"} {
		cause := errors.New("injected " + phase + " failure")
		switch phase {
		case "get":
			f.expect(daoStep{method: "Get", key: current.ID, args: []any{current.ID}, err: cause})
		case "lock":
			f.expect(get(current), method("LockProjectLifecycle", nil, nil, current.ProjectID, current.TaskID), method("LockLedger", nil, cause))
		case "total":
			f.expect(get(current), method("LockProjectLifecycle", nil, nil, current.ProjectID, current.TaskID), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), cause))
		}
		if _, err := f.lifecycle.reserveAdmittedUpload(ctx, p, 1); !errors.Is(err, cause) {
			t.Fatalf("%s failure: %v", phase, err)
		}
	}
	f.expect(get(current), auth(f.actor, current, nil))
	unchanged, err := f.lifecycle.LookupBound(ctx, f.actor, current.ID)
	if err != nil || unchanged.ReservedBytes != 0 || unchanged.OutstandingBytes != 0 || unchanged.Version != current.Version {
		t.Fatalf("accounting after rejected operations: %+v %v", unchanged, err)
	}
}
