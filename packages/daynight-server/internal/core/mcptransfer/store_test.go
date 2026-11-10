package mcptransfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var storageFailure = errors.New("storage failure")

type testDAO struct {
	store.PrivateTransferDAO
	record   model.PrivateTransfer
	calls    []string
	fail     string
	existing bool
	active   int
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

// createReader supplies only the facts used by Create and checks the exact
// operation sequence without modeling persistence.
type createReader struct {
	store.PrivateTransferDAO
	t       *testing.T
	ctx     context.Context
	want    model.PrivateTransfer
	result  model.PrivateTransfer
	created bool
	active  int
	steps   []string
}

func (d *createReader) call(ctx context.Context, name string) {
	d.t.Helper()
	if ctx != d.ctx {
		d.t.Fatalf("%s replaced the original context", name)
	}
	if len(d.steps) == 0 || d.steps[0] != name {
		d.t.Fatalf("unexpected %s call; remaining: %v", name, d.steps)
	}
	d.steps = d.steps[1:]
}

func (d *createReader) Insert(ctx context.Context, record model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	d.call(ctx, "Insert")
	if !reflect.DeepEqual(record, d.want) {
		d.t.Fatalf("Insert record: got %+v, want %+v", record, d.want)
	}
	return d.result, d.created, nil
}

func (d *createReader) LockLedger(ctx context.Context) error {
	d.call(ctx, "LockLedger")
	return nil
}

func (d *createReader) CountActive(ctx context.Context, userID string) (int, error) {
	d.call(ctx, "CountActive")
	if userID != d.want.UserID {
		d.t.Fatalf("CountActive user: got %q, want %q", userID, d.want.UserID)
	}
	return d.active, nil
}

func (d *createReader) verify() {
	d.t.Helper()
	if len(d.steps) != 0 {
		d.t.Errorf("unconsumed Create calls: %v", d.steps)
	}
}

func TestCreateActiveSlotMatrix(t *testing.T) {
	userID, credentialID := uuid.NewString(), uuid.NewString()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for active := 1; active <= 5; active++ {
		t.Run(fmt.Sprintf("active_%d", active), func(t *testing.T) {
			id := uuid.NewString()
			input := model.PrivateTransfer{
				ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
				Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
				Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving",
				CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
			}
			wantInput := model.PrivateTransfer{
				ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
				Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
				Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving",
				CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
			}
			result := model.PrivateTransfer{
				ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
				Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
				Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving", Version: 1,
				CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
			}
			wantResult := model.PrivateTransfer{
				ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
				Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
				Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving", Version: 1,
				CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
			}
			ctx := t.Context()
			d := &createReader{t: t, ctx: ctx, want: wantInput, result: result, created: true, active: active,
				steps: []string{"Insert", "LockLedger", "CountActive"}}
			defer d.verify()
			got, created, err := Create(ctx, d, input)
			if !reflect.DeepEqual(input, wantInput) {
				t.Fatalf("Create changed input: got %+v, want %+v", input, wantInput)
			}
			if active == 5 {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "capacity_unavailable" || created || !reflect.DeepEqual(got, model.PrivateTransfer{}) {
					t.Fatalf("fifth slot: %+v %v %v", got, created, err)
				}
				return
			}
			if err != nil || !created || !reflect.DeepEqual(got, wantResult) {
				t.Fatalf("slot %d: %+v %v %v", active, got, created, err)
			}
		})
	}
}

func TestCreateDuplicateSkipsLedger(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	id, userID, credentialID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	input := model.PrivateTransfer{
		ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
		Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
		Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving",
		CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
	}
	wantInput := model.PrivateTransfer{
		ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
		Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
		Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving",
		CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
	}
	existing := model.PrivateTransfer{
		ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
		Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
		Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving", Version: 1,
		CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
	}
	wantExisting := model.PrivateTransfer{
		ID: id, UserID: userID, AuthorityKind: "pat", AuthorityID: credentialID,
		Direction: "upload", ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain",
		Binding: json.RawMessage(`{"length":3}`), Data: json.RawMessage(`{}`), State: "receiving", Version: 1,
		CreatedAt: at, UpdatedAt: at, ExpiresAt: at.Add(time.Hour), HardExpiresAt: at.Add(24 * time.Hour),
	}
	ctx := t.Context()
	d := &createReader{t: t, ctx: ctx, want: wantInput, result: existing, active: 5, steps: []string{"Insert"}}
	defer d.verify()
	got, created, err := Create(ctx, d, input)
	if err != nil || created || !reflect.DeepEqual(got, wantExisting) {
		t.Fatalf("duplicate: %+v %v %v", got, created, err)
	}
	if !reflect.DeepEqual(input, wantInput) {
		t.Fatalf("Create changed input: got %+v, want %+v", input, wantInput)
	}
}

// reservationPlan supplies independent DAO facts and rejects unplanned calls.
// It does not derive results from write arguments or model storage.
type reservationStep struct {
	name   string
	id     string
	amount int64
	record model.PrivateTransfer
	total  int64
	err    error
}

type reservationPlan struct {
	reservationUnexpected
	ctx   context.Context
	steps []reservationStep
}

func (d *reservationPlan) call(ctx context.Context, name, id string, amount int64) reservationStep {
	d.t.Helper()
	if ctx != d.ctx {
		d.t.Fatalf("%s replaced the original context", name)
	}
	if len(d.steps) == 0 {
		d.t.Fatalf("unexpected %s call after plan exhausted", name)
	}
	step := d.steps[0]
	d.steps = d.steps[1:]
	if step.name != name || step.id != id || step.amount != amount {
		d.t.Fatalf("call %s(%q,%d), want %s(%q,%d)", name, id, amount, step.name, step.id, step.amount)
	}
	return step
}
func (d *reservationPlan) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	s := d.call(ctx, "get", id, 0)
	return s.record, s.err
}
func (d *reservationPlan) LockLedger(ctx context.Context) error {
	return d.call(ctx, "lock", "", 0).err
}
func (d *reservationPlan) ReservedTotal(ctx context.Context) (int64, error) {
	s := d.call(ctx, "total", "", 0)
	return s.total, s.err
}
func (d *reservationPlan) AddReservation(ctx context.Context, id string, amount int64) (model.PrivateTransfer, error) {
	s := d.call(ctx, "add", id, amount)
	return s.record, s.err
}
func (d *reservationPlan) SubtractOutstanding(ctx context.Context, id string, amount int64) (model.PrivateTransfer, error) {
	s := d.call(ctx, "subtract", id, amount)
	return s.record, s.err
}
func (d *reservationPlan) verify() {
	d.t.Helper()
	if len(d.steps) != 0 {
		d.t.Errorf("unconsumed reservation calls: %+v", d.steps)
	}
}

// Any capability outside the narrow plan fails explicitly rather than relying
// on a nil embedded interface if the operation unexpectedly calls it.
type reservationUnexpected struct{ t *testing.T }

func (d reservationUnexpected) unexpected(name string) {
	d.t.Helper()
	d.t.Fatalf("unexpected DAO call: %s", name)
}
func (d reservationUnexpected) Stats(context.Context) (store.PrivateTransferStats, error) {
	d.unexpected("Stats")
	return store.PrivateTransferStats{}, nil
}
func (d reservationUnexpected) Authorize(context.Context, model.Principal, string, string, string, string) error {
	d.unexpected("Authorize")
	return nil
}
func (d reservationUnexpected) LockProjectLifecycle(context.Context, string, string) error {
	d.unexpected("LockProjectLifecycle")
	return nil
}
func (d reservationUnexpected) Insert(context.Context, model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	d.unexpected("Insert")
	return model.PrivateTransfer{}, false, nil
}
func (d reservationUnexpected) CountActive(context.Context, string) (int, error) {
	d.unexpected("CountActive")
	return 0, nil
}
func (d reservationUnexpected) OutstandingTotal(context.Context) (int64, error) {
	d.unexpected("OutstandingTotal")
	return 0, nil
}
func (d reservationUnexpected) Put(context.Context, model.PrivateTransfer, int64) (model.PrivateTransfer, error) {
	d.unexpected("Put")
	return model.PrivateTransfer{}, nil
}
func (d reservationUnexpected) Release(context.Context, model.PrivateTransfer, int64, time.Time, string) (model.PrivateTransfer, error) {
	d.unexpected("Release")
	return model.PrivateTransfer{}, nil
}
func (d reservationUnexpected) UploadChunk(context.Context, string, string) (model.UploadChunk, error) {
	d.unexpected("UploadChunk")
	return model.UploadChunk{}, nil
}
func (d reservationUnexpected) UploadChunkAt(context.Context, string, int64) (model.UploadChunk, error) {
	d.unexpected("UploadChunkAt")
	return model.UploadChunk{}, nil
}
func (d reservationUnexpected) InsertUploadChunk(context.Context, model.UploadChunk) error {
	d.unexpected("InsertUploadChunk")
	return nil
}
func (d reservationUnexpected) Due(context.Context, time.Time, int) ([]model.PrivateTransfer, error) {
	d.unexpected("Due")
	return nil, nil
}
func (d reservationUnexpected) Prune(context.Context, time.Time, int) (int64, error) {
	d.unexpected("Prune")
	return 0, nil
}

func TestReservationAccountingAndFailures(t *testing.T) {
	// These values are supplied facts, not a mutable storage simulation.
	base := model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 10}
	pending := model.PrivateTransfer{ID: "id", State: "cleanup_pending", Version: 3, ReservedBytes: 20, OutstandingBytes: 10}
	rowOverflow := model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: math.MaxInt64, OutstandingBytes: 10}
	initialMax := model.PrivateTransfer{ID: "id", State: "receiving", Version: 1}
	atMax := model.PrivateTransfer{ID: "id", State: "receiving", Version: 2, ReservedBytes: math.MaxInt64, OutstandingBytes: math.MaxInt64}
	before60 := model.PrivateTransfer{ID: "id", State: "receiving", Version: 2, ReservedBytes: 100, OutstandingBytes: 100}
	before40 := model.PrivateTransfer{ID: "id", State: "receiving", Version: 4, ReservedBytes: 100, OutstandingBytes: 40}
	get := func(r model.PrivateTransfer) reservationStep {
		return reservationStep{name: "get", id: "id", record: r}
	}
	lock := reservationStep{name: "lock"}
	total := func(n int64) reservationStep { return reservationStep{name: "total", total: n} }
	add := func(n int64, r model.PrivateTransfer) reservationStep {
		return reservationStep{name: "add", id: "id", amount: n, record: r}
	}
	subtract := func(n int64, r model.PrivateTransfer) reservationStep {
		return reservationStep{name: "subtract", id: "id", amount: n, record: r}
	}

	tests := []struct {
		name          string
		consume       bool
		amount, limit int64 // reservation budget or expected version
		steps         []reservationStep
		want          model.PrivateTransfer
		fault         string
		wantErr       error
	}{
		{name: "reserve_20", amount: 20, limit: 100, steps: []reservationStep{get(base), lock, total(80), add(20, model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 40, OutstandingBytes: 30})}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 40, OutstandingBytes: 30}},
		{name: "reserve_budget_exhausted", amount: 1, limit: 100, steps: []reservationStep{get(base), lock, total(100)}, fault: "capacity_unavailable"},
		{name: "reserve_zero", amount: 0, limit: 100, steps: []reservationStep{get(base), lock, total(0)}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 10}},
		{name: "reserve_negative", amount: -1, limit: 100, fault: "invalid_input"},
		{name: "reserve_cleanup_pending", amount: 1, limit: 100, steps: []reservationStep{get(pending)}, fault: "transfer_conflict"},
		{name: "reserve_record_overflow", amount: 1, limit: math.MaxInt64, steps: []reservationStep{get(rowOverflow), lock, total(0)}, fault: "capacity_unavailable"},
		{name: "reserve_max_int64", amount: math.MaxInt64, limit: math.MaxInt64, steps: []reservationStep{get(initialMax), lock, total(0), add(math.MaxInt64, model.PrivateTransfer{ID: "id", State: "receiving", Version: 2, ReservedBytes: math.MaxInt64, OutstandingBytes: math.MaxInt64})}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 2, ReservedBytes: math.MaxInt64, OutstandingBytes: math.MaxInt64}},
		{name: "reserve_max_int64_plus_one", amount: 1, limit: math.MaxInt64, steps: []reservationStep{get(atMax), lock, total(math.MaxInt64)}, fault: "capacity_unavailable"},
		{name: "consume_6", consume: true, amount: 6, limit: 3, steps: []reservationStep{get(base), lock, subtract(6, model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 4})}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 4}},
		{name: "consume_negative", consume: true, amount: -1, limit: 3, fault: "invalid_input"},
		{name: "consume_over_outstanding", consume: true, amount: 11, limit: 3, steps: []reservationStep{get(base)}, wantErr: model.ErrNotFound},
		{name: "consume_stale_version", consume: true, amount: 1, limit: 2, steps: []reservationStep{get(base)}, wantErr: model.ErrNotFound},
		{name: "consume_zero", consume: true, amount: 0, limit: 3, steps: []reservationStep{get(base)}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 20, OutstandingBytes: 10}},
		{name: "materialization_consume_60", consume: true, amount: 60, limit: 2, steps: []reservationStep{get(before60), lock, subtract(60, model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 100, OutstandingBytes: 40})}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 3, ReservedBytes: 100, OutstandingBytes: 40}},
		{name: "materialization_consume_40", consume: true, amount: 40, limit: 4, steps: []reservationStep{get(before40), lock, subtract(40, model.PrivateTransfer{ID: "id", State: "receiving", Version: 5, ReservedBytes: 100, OutstandingBytes: 0})}, want: model.PrivateTransfer{ID: "id", State: "receiving", Version: 5, ReservedBytes: 100, OutstandingBytes: 0}},
		{name: "materialization_consume_41_rejected", consume: true, amount: 41, limit: 4, steps: []reservationStep{get(before40)}, wantErr: model.ErrNotFound},
		{name: "materialization_stale_40_rejected", consume: true, amount: 40, limit: 3, steps: []reservationStep{get(before40)}, wantErr: model.ErrNotFound},
	}

	// Each failure returns a distinct wrapped error and terminates the plan at
	// the failing operation, independently checking the chain and no later calls.
	for _, stage := range []string{"get", "lock", "total", "add"} {
		steps := []reservationStep{get(base), lock, total(0), add(1, model.PrivateTransfer{})}
		for i := range steps {
			if steps[i].name == stage {
				steps[i].err = fmt.Errorf("%s: %w", stage, storageFailure)
				if stage == "get" {
					steps[i].record = model.PrivateTransfer{}
				}
				steps = steps[:i+1]
				break
			}
		}
		tests = append(tests, struct {
			name          string
			consume       bool
			amount, limit int64
			steps         []reservationStep
			want          model.PrivateTransfer
			fault         string
			wantErr       error
		}{name: "reserve_failure_" + stage, amount: 1, limit: 100, steps: steps, wantErr: storageFailure})
	}
	for _, stage := range []string{"get", "lock", "subtract"} {
		steps := []reservationStep{get(base), lock, subtract(1, model.PrivateTransfer{})}
		for i := range steps {
			if steps[i].name == stage {
				steps[i].err = fmt.Errorf("%s: %w", stage, storageFailure)
				if stage == "get" {
					steps[i].record = model.PrivateTransfer{}
				}
				steps = steps[:i+1]
				break
			}
		}
		tests = append(tests, struct {
			name          string
			consume       bool
			amount, limit int64
			steps         []reservationStep
			want          model.PrivateTransfer
			fault         string
			wantErr       error
		}{name: "consume_failure_" + stage, consume: true, amount: 1, limit: 3, steps: steps, wantErr: storageFailure})
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			// The plan and its input facts must remain unchanged after execution.
			facts := append([]reservationStep(nil), tc.steps...)
			d := &reservationPlan{reservationUnexpected: reservationUnexpected{t: t}, ctx: ctx, steps: append([]reservationStep(nil), tc.steps...)}
			defer d.verify()
			var got model.PrivateTransfer
			var err error
			if tc.consume {
				got, err = ConsumeReservation(ctx, d, "id", tc.amount, tc.limit)
			} else {
				got, err = Reserve(ctx, d, "id", tc.amount, tc.limit)
			}
			if !reflect.DeepEqual(tc.steps, facts) {
				t.Fatalf("supplied facts changed: got %+v, want %+v", tc.steps, facts)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("result: got %+v, want %+v (error %v)", got, tc.want, err)
			}
			if tc.fault != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.fault {
					t.Fatalf("error: got %v, want fault %q", err, tc.fault)
				}
			} else if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("error: got %v, want chain %v", err, tc.wantErr)
				}
				if tc.wantErr == model.ErrNotFound && err != model.ErrNotFound {
					t.Fatalf("error: got %v, want exact ErrNotFound", err)
				}
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
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
