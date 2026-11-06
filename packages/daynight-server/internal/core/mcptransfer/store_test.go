package mcptransfer

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var storageFailure = errors.New("storage failure")

type testDAO struct {
	store.PrivateTransferDAO
	record   model.PrivateTransfer
	calls    []string
	fail     string
	existing bool
	active   int
	total    int64
}

func (d *testDAO) hit(name string) error {
	d.calls = append(d.calls, name)
	if d.fail == name {
		return storageFailure
	}
	return nil
}
func (d *testDAO) Insert(_ context.Context, r model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	e := d.hit("insert")
	return r, !d.existing, e
}
func (d *testDAO) Get(_ context.Context, _ string) (model.PrivateTransfer, error) {
	e := d.hit("get")
	return d.record, e
}
func (d *testDAO) LockLedger(context.Context) error { return d.hit("lock") }
func (d *testDAO) CountActive(context.Context, string) (int, error) {
	e := d.hit("count")
	return d.active, e
}
func (d *testDAO) ReservedTotal(context.Context) (int64, error) {
	e := d.hit("total")
	return d.total, e
}
func (d *testDAO) AddReservation(_ context.Context, _ string, n int64) (model.PrivateTransfer, error) {
	e := d.hit("add")
	d.record.ReservedBytes += n
	d.record.OutstandingBytes += n
	return d.record, e
}
func (d *testDAO) SubtractOutstanding(_ context.Context, _ string, n int64) (model.PrivateTransfer, error) {
	e := d.hit("subtract")
	d.record.OutstandingBytes -= n
	return d.record, e
}
func (d *testDAO) Put(_ context.Context, r model.PrivateTransfer, _ int64) (model.PrivateTransfer, error) {
	e := d.hit("put")
	d.record = r
	return r, e
}
func (d *testDAO) Release(_ context.Context, r model.PrivateTransfer, _ int64, _ time.Time, state string) (model.PrivateTransfer, error) {
	e := d.hit("release")
	r.State = state
	r.ReservedBytes = 0
	r.OutstandingBytes = 0
	return r, e
}
func (d *testDAO) Due(_ context.Context, _ time.Time, _ int) ([]model.PrivateTransfer, error) {
	e := d.hit("due")
	return []model.PrivateTransfer{d.record}, e
}
func (d *testDAO) Prune(_ context.Context, _ time.Time, _ int) (int64, error) {
	e := d.hit("prune")
	return 1, e
}
func calls(t *testing.T, d *testDAO, want ...string) {
	t.Helper()
	if !reflect.DeepEqual(d.calls, want) {
		t.Fatalf("calls %v, want %v", d.calls, want)
	}
}
func TestCreateSlotsAndFailures(t *testing.T) {
	ctx := context.Background()
	r := model.PrivateTransfer{ID: "id", UserID: "user", State: "receiving"}
	d := &testDAO{active: 4}
	got, created, err := Create(ctx, d, r)
	if err != nil || !created || got.ID != r.ID {
		t.Fatalf("fourth slot: %+v %v %v", got, created, err)
	}
	calls(t, d, "insert", "lock", "count")
	d = &testDAO{active: 5}
	if _, _, err = Create(ctx, d, r); err == nil {
		t.Fatal("fifth slot accepted")
	}
	calls(t, d, "insert", "lock", "count")
	d = &testDAO{existing: true, active: 5}
	if _, created, err = Create(ctx, d, r); err != nil || created {
		t.Fatalf("duplicate consumed slot: %v %v", created, err)
	}
	calls(t, d, "insert")
	for _, stage := range []string{"insert", "lock", "count"} {
		d = &testDAO{fail: stage}
		if _, _, err = Create(ctx, d, r); !errors.Is(err, storageFailure) {
			t.Fatalf("%s: %v", stage, err)
		}
	}
	d = &testDAO{}
	r.State = "closed"
	if _, _, err = Create(ctx, d, r); err == nil || len(d.calls) != 0 {
		t.Fatal("invalid initial state")
	}
}
func TestReservationAccountingAndFailures(t *testing.T) {
	ctx := context.Background()
	r := model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 10}
	d := &testDAO{record: r, total: 80}
	got, err := Reserve(ctx, d, r.ID, 20, 100)
	if err != nil || got.ReservedBytes != 40 || got.OutstandingBytes != 30 {
		t.Fatalf("reservation %+v %v", got, err)
	}
	calls(t, d, "get", "lock", "total", "add")
	d = &testDAO{record: r, total: 100}
	if _, err = Reserve(ctx, d, r.ID, 1, 100); err == nil {
		t.Fatal("budget exceeded")
	}
	calls(t, d, "get", "lock", "total")
	d = &testDAO{record: r}
	if got, err = Reserve(ctx, d, r.ID, 0, 100); err != nil || got.ReservedBytes != 20 {
		t.Fatalf("zero reservation %v", err)
	}
	calls(t, d, "get", "lock", "total")
	for _, stage := range []string{"get", "lock", "total", "add"} {
		d = &testDAO{record: r, fail: stage}
		if _, err = Reserve(ctx, d, r.ID, 1, 100); !errors.Is(err, storageFailure) {
			t.Fatalf("%s: %v", stage, err)
		}
	}
	d = &testDAO{record: r}
	if _, err = Reserve(ctx, d, r.ID, -1, 100); err == nil || len(d.calls) > 0 {
		t.Fatal("negative reservation")
	}
	d = &testDAO{record: r}
	d.record.State = "cleanup_pending"
	if _, err = Reserve(ctx, d, r.ID, 1, 100); err == nil {
		t.Fatal("pending reservation")
	}
	d = &testDAO{record: r}
	d.record.ReservedBytes = math.MaxInt64
	if _, err = Reserve(ctx, d, r.ID, 1, math.MaxInt64); err == nil {
		t.Fatal("overflow accepted")
	}
	d = &testDAO{record: r}
	got, err = ConsumeReservation(ctx, d, r.ID, 6, 3)
	if err != nil || got.ReservedBytes != 20 || got.OutstandingBytes != 4 {
		t.Fatalf("consume %+v %v", got, err)
	}
	calls(t, d, "get", "lock", "subtract")
	for _, tc := range []struct{ amount, version int64 }{{-1, 3}, {11, 3}, {1, 2}} {
		d = &testDAO{record: r}
		if _, err = ConsumeReservation(ctx, d, r.ID, tc.amount, tc.version); err == nil {
			t.Fatalf("invalid consumption %+v", tc)
		}
	}
	d = &testDAO{record: r}
	if _, err = ConsumeReservation(ctx, d, r.ID, 0, 3); err != nil {
		t.Fatal(err)
	}
	calls(t, d, "get")
	for _, stage := range []string{"get", "lock", "subtract"} {
		d = &testDAO{record: r, fail: stage}
		if _, err = ConsumeReservation(ctx, d, r.ID, 1, 3); !errors.Is(err, storageFailure) {
			t.Fatalf("%s %v", stage, err)
		}
	}
}
func TestLockedUpdatesAndClose(t *testing.T) {
	ctx := context.Background()
	original := model.PrivateTransfer{ID: "id", State: "committing", Version: 5, Data: []byte(`{"old":true}`), ExpiresAt: time.Unix(100, 0)}
	next := original
	next.State = "cleanup_pending"
	d := &testDAO{record: original}
	pending, err := Update(ctx, d, next, 5)
	if err != nil || pending.CleanupFromState == nil || *pending.CleanupFromState != "committing" {
		t.Fatalf("cleanup barrier %+v %v", pending, err)
	}
	calls(t, d, "get", "put")
	for _, stage := range []string{"get", "put"} {
		d = &testDAO{record: original, fail: stage}
		if _, err = Update(ctx, d, next, 5); !errors.Is(err, storageFailure) {
			t.Fatalf("update %s: %v", stage, err)
		}
	}
	d = &testDAO{record: original}
	if _, err = Update(ctx, d, next, 4); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("stale update %v", err)
	}
	d = &testDAO{record: original}
	next.State = "closed"
	if _, err = Update(ctx, d, next, 5); err == nil || len(d.calls) > 0 {
		t.Fatal("close bypass")
	}
	d = &testDAO{record: pending}
	if _, err = Update(ctx, d, original, 5); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("reopened pending")
	}
	state := "committed"
	receipt := pending
	receipt.CleanupFromState = &state
	receipt.Data = []byte(`{"receipt":true}`)
	receipt.ExpiresAt = time.Time{}
	d = &testDAO{record: pending}
	got, err := UpdatePending(ctx, d, receipt, 5)
	if err != nil || !got.ExpiresAt.Equal(pending.ExpiresAt) || string(got.Data) != string(receipt.Data) || *got.CleanupFromState != "committed" {
		t.Fatalf("pending receipt %+v %v", got, err)
	}
	for _, stage := range []string{"get", "put"} {
		d = &testDAO{record: pending, fail: stage}
		if _, err = UpdatePending(ctx, d, receipt, 5); !errors.Is(err, storageFailure) {
			t.Fatalf("receipt %s %v", stage, err)
		}
	}
	d = &testDAO{record: pending}
	receipt.CleanupFromState = nil
	if _, err = UpdatePending(ctx, d, receipt, 5); err == nil {
		t.Fatal("missing outcome")
	}
	receipt.CleanupFromState = &state
	d = &testDAO{record: original}
	if _, err = UpdatePending(ctx, d, receipt, 5); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("receipt before barrier")
	}
	d = &testDAO{record: pending}
	got, err = Close(ctx, d, "id", 5, time.Unix(200, 0))
	if err != nil || got.State != "closed" || got.ReservedBytes != 0 {
		t.Fatalf("close %+v %v", got, err)
	}
	calls(t, d, "get", "lock", "release")
	for _, stage := range []string{"get", "lock", "release"} {
		d = &testDAO{record: pending, fail: stage}
		if _, err = Close(ctx, d, "id", 5, time.Now()); !errors.Is(err, storageFailure) {
			t.Fatalf("close %s: %v", stage, err)
		}
	}
	d = &testDAO{record: pending}
	if _, err = Close(ctx, d, "id", 4, time.Now()); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("stale close")
	}
}
func TestMaintenanceBatchBoundaries(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	d := &testDAO{}
	if _, err := Due(ctx, d, now, 0); err == nil {
		t.Fatal("empty due")
	}
	if _, err := Prune(ctx, d, now, 101); err == nil {
		t.Fatal("oversized prune")
	}
	if len(d.calls) > 0 {
		t.Fatal("invalid batch queried DAO")
	}
	if _, err := Due(ctx, d, now, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := Prune(ctx, d, now, 1); err != nil {
		t.Fatal(err)
	}
	calls(t, d, "due", "prune")
}
