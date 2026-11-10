package mcptransfer

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type transferOperationPlan struct {
	store.PrivateTransferDAO
	t        *testing.T
	ctx      context.Context
	expected []string
	position int
	record   model.PrivateTransfer
	getError error
}

func (p *transferOperationPlan) call(ctx context.Context, name string) {
	p.t.Helper()
	if ctx != p.ctx || p.position >= len(p.expected) || p.expected[p.position] != name {
		p.t.Fatalf("unexpected transfer operation %q at %d, plan=%v", name, p.position, p.expected)
	}
	p.position++
}

func (p *transferOperationPlan) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	p.call(ctx, "get")
	if id != p.record.ID {
		p.t.Fatalf("transfer lookup=%s want=%s", id, p.record.ID)
	}
	return p.record, p.getError
}

func (p *transferOperationPlan) LockLedger(ctx context.Context) error {
	p.call(ctx, "lock")
	return nil
}

func (p *transferOperationPlan) ReservedTotal(ctx context.Context) (int64, error) {
	p.call(ctx, "total")
	return 0, nil
}

func TestPrivateTransferRejectsInvalidOperations(t *testing.T) {
	base := model.PrivateTransfer{ID: "transfer", UserID: "user", State: "receiving", Version: 3}
	closed := base
	closed.State = "closed"
	pending := base
	pending.State = "cleanup_pending"
	missing := base
	missing.ID = "missing"
	reserved := base
	reserved.ReservedBytes = 1
	for _, tc := range []struct {
		name      string
		record    model.PrivateTransfer
		getError  error
		expected  []string
		op        func(context.Context, *transferOperationPlan) (model.PrivateTransfer, error)
		wantError bool
	}{
		{"initial reservation", reserved, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			r, _, err := Create(ctx, d, reserved)
			return r, err
		}, true},
		{"negative reservation", base, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Reserve(ctx, d, base.ID, -1, 100)
		}, true},
		{"missing reservation", missing, model.ErrNotFound, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Reserve(ctx, d, missing.ID, 1, 100)
		}, true},
		{"zero reservation", base, nil, []string{"get", "lock", "total"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Reserve(ctx, d, base.ID, 0, 100)
		}, false},
		{"negative consumption", base, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return ConsumeReservation(ctx, d, base.ID, -1, base.Version)
		}, true},
		{"missing consumption", missing, model.ErrNotFound, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return ConsumeReservation(ctx, d, missing.ID, 1, 1)
		}, true},
		{"zero consumption", base, nil, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return ConsumeReservation(ctx, d, base.ID, 0, base.Version)
		}, false},
		{"close bypass", closed, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Update(ctx, d, closed, closed.Version)
		}, true},
		{"missing pending outcome", base, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return UpdatePending(ctx, d, base, base.Version)
		}, true},
		{"missing close", missing, model.ErrNotFound, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Close(ctx, d, missing.ID, 1, time.Unix(100, 0))
		}, true},
		{"close before cleanup", base, nil, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Close(ctx, d, base.ID, base.Version, time.Unix(100, 0))
		}, true},
		{"empty due batch", base, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			_, err := Due(ctx, d, time.Unix(100, 0), 0)
			return model.PrivateTransfer{}, err
		}, true},
		{"oversized prune batch", base, nil, nil, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			_, err := Prune(ctx, d, time.Unix(100, 0), 101)
			return model.PrivateTransfer{}, err
		}, true},
		{"reservation after cleanup", pending, nil, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			return Reserve(ctx, d, pending.ID, 1, 100)
		}, true},
		{"stale pending outcome", pending, nil, []string{"get"}, func(ctx context.Context, d *transferOperationPlan) (model.PrivateTransfer, error) {
			state := "committed"
			r := pending
			r.CleanupFromState = &state
			r.Data = []byte(`{"operationId":"result"}`)
			return UpdatePending(ctx, d, r, r.Version-1)
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			plan := &transferOperationPlan{t: t, ctx: ctx, expected: tc.expected, record: tc.record, getError: tc.getError}
			got, err := tc.op(ctx, plan)
			if (err != nil) != tc.wantError || plan.position != len(plan.expected) || !reflect.DeepEqual(plan.record, tc.record) {
				t.Fatalf("transfer refusal or call plan changed: result=%#v record=%#v calls=%d error=%v", got, plan.record, plan.position, err)
			}
			if !tc.wantError && !reflect.DeepEqual(got, base) {
				t.Fatalf("zero operation changed transfer: %#v", got)
			}
			if tc.getError != nil && !errors.Is(err, tc.getError) {
				t.Fatalf("lookup cause lost: %v", err)
			}
		})
	}
}
