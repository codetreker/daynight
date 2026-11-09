package mcptransfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMain(m *testing.M) {
	for _, key := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_URL", "DAYNIGHT_TEST_UNIAUTH_CLIENT_ID", "DAYNIGHT_TEST_UNIAUTH_CLIENT_SECRET", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(key); err != nil {
			panic(err)
		}
	}
	os.Exit(m.Run())
}

type lifecycleFixture struct {
	t         *testing.T
	db        *transferWriter
	files     *local.Storage
	lifecycle *Lifecycle
	actor     transfer.Actor
	binding   transfer.Binding
	root      string
}

func newFixture(t *testing.T) lifecycleFixture {
	t.Helper()
	actor := transfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, AuthorityKind: "pat"}
	actor.AuthorityID = actor.Principal.CredentialID
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	db := &transferWriter{t: t}
	lifecycle, err := New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	f := lifecycleFixture{
		t: t, db: db, files: files, lifecycle: lifecycle, actor: actor, root: root,
		binding: transfer.Binding{
			ID: uuid.NewString(), Direction: "upload", ProjectID: uuid.NewString(),
			TaskID: uuid.NewString(), Path: "file", ContentType: "text/plain",
			Parameters: json.RawMessage(`{"length":3}`),
		},
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
		db.verify()
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return f
}
func (f lifecycleFixture) record() model.PrivateTransfer {
	r, err := transfer.NewRecord(f.actor, f.binding, time.Now().UTC())
	if err != nil {
		f.t.Fatal(err)
	}
	r.Version = 1
	return cloneTransfer(r)
}
func (f lifecycleFixture) expect(steps ...daoStep) {
	f.db.expect(store.Completion{Outcome: store.TransactionCommitted}, nil, steps...)
}
func cloneTransfer(r model.PrivateTransfer) model.PrivateTransfer {
	r.Binding = append(json.RawMessage(nil), r.Binding...)
	r.Data = append(json.RawMessage(nil), r.Data...)
	if r.LeaseUntil != nil {
		v := *r.LeaseUntil
		r.LeaseUntil = &v
	}
	if r.CleanupFromState != nil {
		v := *r.CleanupFromState
		r.CleanupFromState = &v
	}
	if r.RetainUntil != nil {
		v := *r.RetainUntil
		r.RetainUntil = &v
	}
	if r.LastCleanupAttempt != nil {
		v := *r.LastCleanupAttempt
		r.LastCleanupAttempt = &v
	}
	return r
}

type daoStep struct {
	matchContext func(context.Context) bool
	ctx          func(context.Context)
	method, key  string
	args         []any
	check        func([]any)
	result       any
	err          error
}

func get(r model.PrivateTransfer) daoStep {
	return daoStep{method: "Get", key: r.ID, args: []any{r.ID}, result: cloneTransfer(r)}
}
func getMissing(id string) daoStep {
	return daoStep{method: "Get", key: id, args: []any{id}, err: model.ErrNotFound}
}
func auth(a transfer.Actor, r model.PrivateTransfer, err error) daoStep {
	return daoStep{method: "Authorize", key: a.Principal.UserID + ":" + r.ProjectID + ":" + r.TaskID, args: []any{a.Principal, a.AuthorityKind, a.AuthorityID, r.ProjectID, r.TaskID}, err: err}
}
func put(input model.PrivateTransfer, version int64, result model.PrivateTransfer, err error) daoStep {
	return daoStep{method: "Put", args: []any{cloneTransfer(input), version}, result: cloneTransfer(result), err: err}
}
func method(name string, result any, err error, args ...any) daoStep {
	return daoStep{method: name, args: args, result: result, err: err}
}

type transferPlan struct {
	steps         []daoStep
	completion    store.Completion
	callbackCheck func(error)
	err           error
}
type transferWriter struct {
	t     *testing.T
	mu    sync.Mutex
	plans []*transferPlan
}

func (w *transferWriter) expect(c store.Completion, err error, steps ...daoStep) *transferPlan {
	w.mu.Lock()
	defer w.mu.Unlock()
	p := &transferPlan{steps: steps, completion: c, err: err}
	w.plans = append(w.plans, p)
	return p
}
func (w *transferWriter) fail(format string, args ...any) {
	w.t.Helper()
	w.t.Errorf(format, args...)
	panic(fmt.Sprintf(format, args...))
}
func (w *transferWriter) verify() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.plans) != 0 {
		w.t.Errorf("unconsumed transfer transactions: %d", len(w.plans))
	}
}
func (w *transferWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (completion store.Completion, transactionErr error) {
	defer func() {
		if value := recover(); value != nil {
			w.t.Errorf("private transfer callback panicked: %v", value)
			completion = store.Completion{Outcome: store.TransactionNotCommitted}
			transactionErr = fmt.Errorf("private transfer callback panicked: %v", value)
		}
	}()
	d := &transferDAO{writer: w, ctx: ctx}
	err := fn(d)
	if d.plan == nil {
		w.fail("transaction made no configured DAO call")
	}
	if len(d.plan.steps) != 0 {
		w.fail("transaction left %d DAO steps, next %s", len(d.plan.steps), d.plan.steps[0].method)
	}
	if d.plan.callbackCheck != nil {
		d.plan.callbackCheck(err)
	}
	return d.plan.completion, errors.Join(err, d.plan.err)
}

type transferDAO struct {
	ctx    context.Context
	writer *transferWriter
	plan   *transferPlan
}

func (d *transferDAO) call(ctx context.Context, name, key string, args ...any) (any, error) {
	w := d.writer
	if ctx != d.ctx {
		w.fail("DAO %s replaced transaction context", name)
	}
	if d.plan == nil {
		w.mu.Lock()
		for i, p := range w.plans {
			if len(p.steps) > 0 && p.steps[0].method == name && (p.steps[0].key == "" || p.steps[0].key == key) && (p.steps[0].matchContext == nil || p.steps[0].matchContext(ctx)) {
				d.plan = p
				w.plans = append(w.plans[:i], w.plans[i+1:]...)
				break
			}
		}
		w.mu.Unlock()
		if d.plan == nil {
			w.fail("unexpected DAO %s(%s)", name, key)
		}
	}
	if len(d.plan.steps) == 0 {
		w.fail("extra DAO %s", name)
	}
	s := d.plan.steps[0]
	d.plan.steps = d.plan.steps[1:]
	if s.method != name {
		w.fail("DAO call %s, expected %s", name, s.method)
	}
	if s.args != nil && !reflect.DeepEqual(s.args, args) {
		w.fail("DAO %s args %#v, expected %#v", name, args, s.args)
	}
	if s.ctx != nil {
		s.ctx(ctx)
	}
	if s.check != nil {
		s.check(args)
	}
	result := s.result
	if reply, ok := result.(func() any); ok {
		result = reply()
	}
	if result == nil && s.err == nil {
		switch name {
		case "Authorize", "LockProjectLifecycle", "LockLedger", "InsertUploadChunk":
		default:
			w.fail("DAO %s has no configured result", name)
		}
	}
	return result, s.err
}
func value[T any](v any) T {
	if v == nil {
		var zero T
		return zero
	}
	return v.(T)
}
func (d *transferDAO) Stats(ctx context.Context) (store.PrivateTransferStats, error) {
	v, e := d.call(ctx, "Stats", "")
	return value[store.PrivateTransferStats](v), e
}
func (d *transferDAO) Authorize(ctx context.Context, p model.Principal, kind, id, project, task string) error {
	_, e := d.call(ctx, "Authorize", p.UserID+":"+project+":"+task, p, kind, id, project, task)
	return e
}
func (d *transferDAO) LockProjectLifecycle(ctx context.Context, project, task string) error {
	_, e := d.call(ctx, "LockProjectLifecycle", "", project, task)
	return e
}
func (d *transferDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	v, e := d.call(ctx, "Get", id, id)
	return cloneTransfer(value[model.PrivateTransfer](v)), e
}
func (d *transferDAO) Insert(ctx context.Context, r model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	v, e := d.call(ctx, "Insert", "", r)
	x := value[insertFact](v)
	return cloneTransfer(x.record), x.created, e
}

type insertFact struct {
	record  model.PrivateTransfer
	created bool
}

func (d *transferDAO) CountActive(ctx context.Context, id string) (int, error) {
	v, e := d.call(ctx, "CountActive", "", id)
	return value[int](v), e
}
func (d *transferDAO) LockLedger(ctx context.Context) error {
	_, e := d.call(ctx, "LockLedger", "")
	return e
}
func (d *transferDAO) ReservedTotal(ctx context.Context) (int64, error) {
	v, e := d.call(ctx, "ReservedTotal", "")
	return value[int64](v), e
}
func (d *transferDAO) OutstandingTotal(ctx context.Context) (int64, error) {
	v, e := d.call(ctx, "OutstandingTotal", "")
	return value[int64](v), e
}
func (d *transferDAO) AddReservation(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
	v, e := d.call(ctx, "AddReservation", "", id, n)
	return cloneTransfer(value[model.PrivateTransfer](v)), e
}
func (d *transferDAO) SubtractOutstanding(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
	v, e := d.call(ctx, "SubtractOutstanding", "", id, n)
	return cloneTransfer(value[model.PrivateTransfer](v)), e
}
func (d *transferDAO) Put(ctx context.Context, r model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	v, e := d.call(ctx, "Put", "", r, version)
	return cloneTransfer(value[model.PrivateTransfer](v)), e
}
func (d *transferDAO) Release(ctx context.Context, r model.PrivateTransfer, version int64, until time.Time, reason string) (model.PrivateTransfer, error) {
	v, e := d.call(ctx, "Release", "", r, version, until, reason)
	return cloneTransfer(value[model.PrivateTransfer](v)), e
}
func (d *transferDAO) UploadChunk(ctx context.Context, id, chunk string) (model.UploadChunk, error) {
	v, e := d.call(ctx, "UploadChunk", "", id, chunk)
	return value[model.UploadChunk](v), e
}
func (d *transferDAO) UploadChunkAt(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
	v, e := d.call(ctx, "UploadChunkAt", "", id, offset)
	return value[model.UploadChunk](v), e
}
func (d *transferDAO) InsertUploadChunk(ctx context.Context, r model.UploadChunk) error {
	_, e := d.call(ctx, "InsertUploadChunk", "", r)
	return e
}
func (d *transferDAO) Due(ctx context.Context, now time.Time, limit int) ([]model.PrivateTransfer, error) {
	v, e := d.call(ctx, "Due", "", now, limit)
	rs := value[[]model.PrivateTransfer](v)
	out := make([]model.PrivateTransfer, len(rs))
	for i, r := range rs {
		out[i] = cloneTransfer(r)
	}
	return out, e
}
func (d *transferDAO) Prune(ctx context.Context, now time.Time, limit int) (int64, error) {
	v, e := d.call(ctx, "Prune", "", now, limit)
	return value[int64](v), e
}

func openRecord(t *testing.T, f lifecycleFixture) model.PrivateTransfer {
	t.Helper()
	r := f.record()
	f.expect(getMissing(r.ID), auth(f.actor, r, nil), daoStep{method: "Insert", check: checkInitialRecord(t, r), result: insertFact{cloneTransfer(r), true}}, method("LockLedger", nil, nil), method("CountActive", 1, nil, r.UserID))
	got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
	if err != nil || !created || !reflect.DeepEqual(got, r) {
		t.Fatalf("open: %+v created=%v error=%v", got, created, err)
	}
	return r
}

func checkInitialRecord(t *testing.T, record model.PrivateTransfer) func([]any) {
	record = cloneTransfer(record)
	return func(args []any) {
		t.Helper()
		r := record

		v := args[0].(model.PrivateTransfer)
		want := cloneTransfer(r)
		want.Version = 0
		want.CreatedAt = v.CreatedAt
		want.UpdatedAt = v.UpdatedAt
		want.ExpiresAt = v.ExpiresAt
		want.HardExpiresAt = v.HardExpiresAt
		if !reflect.DeepEqual(v, want) || !v.UpdatedAt.Equal(v.CreatedAt) || v.CreatedAt.Before(time.Now().Add(-time.Second)) || v.CreatedAt.After(time.Now()) {
			t.Errorf("insert input: %+v", v)
		}
		if v.ExpiresAt.Sub(v.CreatedAt) != time.Hour || v.HardExpiresAt.Sub(v.CreatedAt) != 24*time.Hour {
			t.Error("initial expiry bounds")
		}
	}
}

func checkTransfer(t *testing.T, want model.PrivateTransfer, renew bool) func([]any) {
	want = cloneTransfer(want)
	return func(args []any) {
		t.Helper()
		got := args[0].(model.PrivateTransfer)
		if args[1].(int64) != want.Version {
			t.Errorf("write version %v, want %d", args[1], want.Version)
		}
		if renew {
			now := time.Now()
			if got.UpdatedAt.Before(want.UpdatedAt) || got.UpdatedAt.After(now) {
				t.Errorf("updated time outside operation: %v", got.UpdatedAt)
			}
			if got.ExpiresAt.After(got.HardExpiresAt) || got.ExpiresAt.Before(now.Add(time.Hour-time.Second)) && !got.ExpiresAt.Equal(got.HardExpiresAt) {
				t.Errorf("renewed expiry out of bounds: %v", got.ExpiresAt)
			}
			got.UpdatedAt = want.UpdatedAt
			got.ExpiresAt = want.ExpiresAt
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("proposed transfer\n got %+v\nwant %+v", got, want)
		}
	}
}
func (f lifecycleFixture) expectPermit(r model.PrivateTransfer) model.PrivateTransfer {
	result := cloneTransfer(r)
	result.Version++
	f.expect(get(r), auth(f.actor, r, nil), get(r), daoStep{method: "Put", check: checkTransfer(f.t, r, true), result: result})
	return result
}
func (f lifecycleFixture) permit(r model.PrivateTransfer) *Permit {
	f.t.Helper()
	f.expectPermit(r)
	p, err := f.lifecycle.AcquirePermit(f.t.Context(), f.actor, r.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		if err := p.Close(); err != nil {
			f.t.Error(err)
		}
	})
	return p
}
func (f lifecycleFixture) expectSweep(due []model.PrivateTransfer, stats store.PrivateTransferStats) {
	f.expect(daoStep{method: "Due", check: func(args []any) {
		if args[1] != SweepLimit {
			f.t.Errorf("due limit: %v", args)
		}
	}, result: due})
	f.expect(daoStep{method: "Prune", check: func(args []any) {
		if args[1] != SweepLimit {
			f.t.Errorf("prune limit: %v", args)
		}
	}, result: int64(0)})
	f.expect(method("Stats", stats, nil))
}
