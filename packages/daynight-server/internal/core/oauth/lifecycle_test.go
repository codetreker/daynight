package oauth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type lifecycleFake struct {
	store.GrantLifecycleDAO
	now         time.Time
	failures    map[string]error
	calls       map[string]int
	grant       store.OAuthGrant
	refresh     store.OAuthRefresh
	accessGrant string
	outcome     store.TransactionOutcome
	pruneCounts []int
	pruneLimits []int
}

type skewedOwnerWriter struct {
	*lifecycleFake
	databaseTime time.Time
}

func (w skewedOwnerWriter) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	err := fn(skewedOwnerDAO{GrantLifecycleDAO: w.lifecycleFake, databaseTime: w.databaseTime})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type skewedOwnerDAO struct {
	store.GrantLifecycleDAO
	databaseTime time.Time
}

func (d skewedOwnerDAO) FreshTime(_ context.Context, caller time.Time) (time.Time, error) {
	if caller.After(d.databaseTime) {
		return caller, nil
	}
	return d.databaseTime, nil
}

func (d skewedOwnerDAO) LockOwnerSession(context.Context, model.Principal, time.Time) error {
	return nil
}

func TestSessionGrantListReturnsDatabaseObservationTime(t *testing.T) {
	f := newLifecycleFake()
	databaseTime := time.Now().UTC().Add(2 * time.Hour)
	f.grant.ExpiresAt = databaseTime.Add(-time.Hour)
	s := NewGrantLifecycle(skewedOwnerWriter{lifecycleFake: f, databaseTime: databaseTime})
	s.now = func() time.Time { return databaseTime.Add(-3 * time.Hour) }
	p := model.Principal{Kind: model.SessionCredential, UserID: f.grant.UserID, CredentialID: uuid.NewString()}
	items, observed, err := s.ListSessionGrants(t.Context(), p)
	if err != nil || len(items) != 1 || !observed.Equal(databaseTime) || items[0].ExpiresAt.After(observed) {
		t.Fatalf("database observation: %+v %v %v", items, observed, err)
	}
}

func (f *lifecycleFake) failure(name string) error {
	f.calls[name]++
	return f.failures[fmt.Sprintf("%s:%d", name, f.calls[name])]
}
func (f *lifecycleFake) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	if e := f.failure("transaction"); e != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, e
	}
	err := fn(f)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if f.outcome != "" {
		return store.Completion{Outcome: f.outcome}, nil
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *lifecycleFake) Refresh(_ context.Context, _ []byte, _ bool) (store.OAuthRefresh, error) {
	return f.refresh, f.failure("refresh")
}
func (f *lifecycleFake) InspectGrant(_ context.Context, _ string, _ bool) (store.OAuthGrant, error) {
	return f.grant, f.failure("grant")
}
func (f *lifecycleFake) AccessGrant(_ context.Context, _ []byte) (string, error) {
	return f.accessGrant, f.failure("access")
}
func (f *lifecycleFake) FreshTime(_ context.Context, _ time.Time) (time.Time, error) {
	return f.now, f.failure("time")
}
func (f *lifecycleFake) LockOwnerSession(_ context.Context, _ model.Principal, _ time.Time) error {
	return f.failure("session")
}
func (f *lifecycleFake) RevokeFamily(_ context.Context, _ string, _ time.Time) (bool, error) {
	return true, f.failure("revoke")
}
func (f *lifecycleFake) RotateRefresh(_ context.Context, _ store.OAuthRotation) error {
	return f.failure("rotate")
}
func (f *lifecycleFake) OwnerGrants(_ context.Context, _ string) ([]store.OAuthGrant, error) {
	return []store.OAuthGrant{f.grant}, f.failure("list")
}
func (f *lifecycleFake) PruneCredentials(_ context.Context, _ time.Time, limit int) (int, error) {
	f.pruneLimits = append(f.pruneLimits, limit)
	err := f.failure("prune")
	if len(f.pruneCounts) == 0 {
		return 0, err
	}
	n := f.pruneCounts[0]
	f.pruneCounts = f.pruneCounts[1:]
	return n, err
}
func newLifecycleFake() *lifecycleFake {
	now := time.Now().UTC()
	id := uuid.NewString()
	return &lifecycleFake{now: now, failures: map[string]error{}, calls: map[string]int{}, grant: store.OAuthGrant{ID: id, UserID: uuid.NewString(), ClientID: "client", Resource: "https://example.test/mcp", Scope: Scope, ExpiresAt: now.Add(time.Hour)}, refresh: store.OAuthRefresh{GrantID: id, ClientID: "client", ExpiresAt: now.Add(time.Hour)}, accessGrant: id}
}

func TestSessionGrantOwnershipAndFailures(t *testing.T) {
	f := newLifecycleFake()
	p := model.Principal{Kind: model.SessionCredential, UserID: f.grant.UserID, CredentialID: uuid.NewString()}
	s := NewGrantLifecycle(f)
	items, observed, err := s.ListSessionGrants(t.Context(), p)
	if err != nil || len(items) != 1 || items[0].ID != f.grant.ID || !observed.Equal(f.now) {
		t.Fatalf("session list: %+v %v %v", items, observed, err)
	}
	changed, err := s.RevokeSessionGrant(t.Context(), p, f.grant.ID)
	if err != nil || !changed {
		t.Fatalf("session revoke: %v %v", changed, err)
	}
	changed, err = s.RevokeOwnerGrant(t.Context(), p.UserID, f.grant.ID)
	if err != nil || !changed {
		t.Fatalf("owner revoke: %v %v", changed, err)
	}
	for _, invalid := range []model.Principal{{}, {Kind: model.PATCredential, UserID: p.UserID, CredentialID: p.CredentialID}, {Kind: model.SessionCredential, UserID: p.UserID, CredentialID: "bad"}} {
		if _, _, err := s.ListSessionGrants(t.Context(), invalid); err == nil {
			t.Fatalf("invalid list principal: %+v", invalid)
		}
		if _, err := s.RevokeSessionGrant(t.Context(), invalid, f.grant.ID); err == nil {
			t.Fatalf("invalid revoke principal: %+v", invalid)
		}
	}
	if _, err := s.RevokeSessionGrant(t.Context(), p, "bad"); err == nil {
		t.Fatal("invalid grant ID")
	}
	if _, err := s.RevokeSessionGrant(t.Context(), model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: p.CredentialID}, f.grant.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign grant: %v", err)
	}
	boom := errors.New("failed operation")
	for _, op := range []struct {
		name string
		list bool
	}{{"time:1", true}, {"session:1", true}, {"list:1", true}, {"time:2", true}, {"session:2", true}, {"grant:1", false}, {"time:1", false}, {"session:1", false}, {"time:2", false}, {"revoke:1", false}, {"time:3", false}, {"session:2", false}} {
		t.Run(fmt.Sprintf("%s/list=%v", op.name, op.list), func(t *testing.T) {
			f := newLifecycleFake()
			p := model.Principal{Kind: model.SessionCredential, UserID: f.grant.UserID, CredentialID: uuid.NewString()}
			f.failures[op.name] = boom
			s := NewGrantLifecycle(f)
			if op.list {
				items, observed, err := s.ListSessionGrants(t.Context(), p)
				if !errors.Is(err, boom) || items != nil || !observed.IsZero() {
					t.Fatalf("list failure: %+v %v %v", items, observed, err)
				}
			} else {
				changed, err := s.RevokeSessionGrant(t.Context(), p, f.grant.ID)
				if !errors.Is(err, boom) || changed {
					t.Fatalf("revoke failure: %v %v", changed, err)
				}
			}
		})
	}
	for _, list := range []bool{false, true} {
		f := newLifecycleFake()
		p := model.Principal{Kind: model.SessionCredential, UserID: f.grant.UserID, CredentialID: uuid.NewString()}
		f.failures["session:1"] = model.ErrNotFound
		s := NewGrantLifecycle(f)
		var err error
		if list {
			_, _, err = s.ListSessionGrants(t.Context(), p)
		} else {
			_, err = s.RevokeSessionGrant(t.Context(), p, f.grant.ID)
		}
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatalf("missing session: %v", err)
		}
	}
	for _, list := range []bool{false, true} {
		f := newLifecycleFake()
		p := model.Principal{Kind: model.SessionCredential, UserID: f.grant.UserID, CredentialID: uuid.NewString()}
		f.outcome = store.TransactionUnknown
		s := NewGrantLifecycle(f)
		var err error
		if list {
			_, _, err = s.ListSessionGrants(t.Context(), p)
		} else {
			_, err = s.RevokeSessionGrant(t.Context(), p, f.grant.ID)
		}
		if !errors.Is(err, ErrAuthorizationUnknown) {
			t.Fatalf("unknown outcome: %v", err)
		}
	}
}
func TestRotationFailuresDoNotReleaseSecrets(t *testing.T) {
	boom := errors.New("injected failure")
	token := secret.Random(RefreshPrefix)
	for _, step := range []string{"refresh:1", "grant:1", "refresh:2", "grant:2", "refresh:3", "time:1", "rotate:1"} {
		t.Run(step, func(t *testing.T) {
			f := newLifecycleFake()
			f.failures[step] = boom
			result, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil })
			if !errors.Is(err, boom) || result.AccessToken != "" || result.RefreshToken != "" {
				t.Fatalf("failure leaked token: %+v %v", result, err)
			}
		})
	}
	for _, step := range []string{"refresh:1", "grant:1", "refresh:2", "grant:2", "refresh:3"} {
		t.Run("missing "+step, func(t *testing.T) {
			f := newLifecycleFake()
			f.failures[step] = model.ErrNotFound
			_, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil })
			if !errors.Is(err, ErrInvalidGrant) {
				t.Fatalf("missing: %v", err)
			}
		})
	}
	f := newLifecycleFake()
	f.outcome = store.TransactionUnknown
	if result, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, ErrAuthorizationUnknown) || result.AccessToken != "" {
		t.Fatalf("unknown read: %+v %v", result, err)
	}
	f = newLifecycleFake()
	used := f.now
	f.refresh.ConsumedAt = &used
	f.failures["revoke:1"] = boom
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, boom) {
		t.Fatalf("replay failure: %v", err)
	}
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), "invalid", "client", f.grant.Resource, nil); !errors.Is(err, ErrInvalidGrant) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.grant.RevokedAt = &used
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, ErrInvalidGrant) {
		t.Fatal(err)
	}
}
func TestPublicRevocationFailuresAndUnknownTokens(t *testing.T) {
	boom := errors.New("injected failure")
	for _, tc := range []struct{ token, step string }{
		{secret.Random(RefreshPrefix), "refresh:1"}, {secret.Random(RefreshPrefix), "grant:1"}, {secret.Random(RefreshPrefix), "refresh:2"}, {secret.Random(RefreshPrefix), "time:1"}, {secret.Random(RefreshPrefix), "revoke:1"},
		{secret.Random(model.OAuthAccessPrefix), "access:1"}, {secret.Random(model.OAuthAccessPrefix), "access:2"},
	} {
		f := newLifecycleFake()
		f.failures[tc.step] = boom
		if err := NewGrantLifecycle(f).RevokePublic(t.Context(), tc.token, "client"); !errors.Is(err, boom) {
			t.Fatalf("%s: %v", tc.step, err)
		}
	}
	for _, tc := range []struct{ token, step string }{{secret.Random(RefreshPrefix), "refresh:1"}, {secret.Random(RefreshPrefix), "grant:1"}, {secret.Random(RefreshPrefix), "refresh:2"}, {secret.Random(model.OAuthAccessPrefix), "access:1"}, {secret.Random(model.OAuthAccessPrefix), "access:2"}} {
		f := newLifecycleFake()
		f.failures[tc.step] = model.ErrNotFound
		if err := NewGrantLifecycle(f).RevokePublic(t.Context(), tc.token, "client"); err != nil {
			t.Fatalf("unknown %s: %v", tc.step, err)
		}
	}
	f := newLifecycleFake()
	f.accessGrant = uuid.NewString()
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), secret.Random(model.OAuthAccessPrefix), "client"); err != nil || f.calls["revoke"] != 0 {
		t.Fatalf("changed binding: %v", err)
	}
	f = newLifecycleFake()
	f.refresh.ClientID = "other"
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), secret.Random(RefreshPrefix), "client"); err != nil || f.calls["revoke"] != 0 {
		t.Fatalf("changed binding: %v", err)
	}
	for _, prefix := range []string{model.OAuthAccessPrefix, RefreshPrefix} {
		f := newLifecycleFake()
		if err := NewGrantLifecycle(f).RevokePublic(t.Context(), secret.Random(prefix), "other"); err != nil || f.calls["revoke"] != 0 {
			t.Fatalf("foreign client revoked family: %v", err)
		}
	}
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), "malformed", "client"); err != nil {
		t.Fatal(err)
	}
}
func TestLifecycleOwnerAndMaintenanceFailures(t *testing.T) {
	boom := errors.New("injected failure")
	f := newLifecycleFake()
	lifecycle := NewGrantLifecycle(f)
	if _, err := lifecycle.ListOwnerGrants(t.Context(), "bad"); err == nil {
		t.Fatal("invalid owner accepted")
	}
	f.failures["list:1"] = boom
	if _, err := lifecycle.ListOwnerGrants(t.Context(), f.grant.UserID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if _, err := lifecycle.RevokeOwnerGrant(t.Context(), "bad", f.grant.ID); err == nil {
		t.Fatal("invalid owner accepted")
	}
	f.failures["grant:1"] = boom
	if _, err := lifecycle.RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["time:1"] = boom
	if _, err := NewGrantLifecycle(f).RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["revoke:1"] = boom
	if _, err := NewGrantLifecycle(f).RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["prune:1"] = boom
	if _, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), 100); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if _, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), -1); err == nil {
		t.Fatal("invalid budget accepted")
	}
	now := time.Now()
	if minTime(now, now.Add(time.Second)) != now || minTime(now.Add(time.Second), now) != now {
		t.Fatal("minimum time mismatch")
	}
}

func TestCredentialPruneBatchAndLimit(t *testing.T) {
	f := newLifecycleFake()
	f.pruneCounts = []int{100, 10}
	n, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), 200)
	if err != nil || n != 110 || len(f.pruneLimits) != 2 || f.pruneLimits[0] != 100 || f.pruneLimits[1] != 100 {
		t.Fatalf("batch: %d %v %v", n, f.pruneLimits, err)
	}
	f = newLifecycleFake()
	f.pruneCounts = make([]int, 20)
	for i := range f.pruneCounts {
		f.pruneCounts[i] = 100
	}
	n, err = NewGrantLifecycle(f).PruneCredentials(t.Context(), 5000)
	if err != nil || n != 2000 || len(f.pruneLimits) != 20 {
		t.Fatalf("bounded: %d calls=%d %v", n, len(f.pruneLimits), err)
	}
	if n, err = NewGrantLifecycle(newLifecycleFake()).PruneCredentials(t.Context(), 0); err != nil || n != 0 {
		t.Fatalf("zero budget: %d %v", n, err)
	}
}

type lifecycleStep struct {
	method  string
	lock    bool
	refresh store.OAuthRefresh
	grant   store.OAuthGrant
	grants  []store.OAuthGrant
	now     time.Time
	changed bool
}

type lifecycleWrite struct {
	steps       []lifecycleStep
	outcome     store.TransactionOutcome
	callbackErr error
	writeErr    error
	admitted    bool
}

type lifecyclePlan struct {
	t            *testing.T
	ctx          context.Context
	writes       []lifecycleWrite
	transactions int
	active       bool
	admissions   int
	admissionErr error
	grant        store.OAuthGrant
	refresh      store.OAuthRefresh
	token        string
	now          time.Time
	rotationTime time.Time
	rotation     *store.OAuthRotation
	revocations  int
}

type lifecyclePlanDAO struct {
	store.GrantLifecycleDAO
	plan  *lifecyclePlan
	steps []lifecycleStep
}

func (d *lifecyclePlanDAO) next(ctx context.Context, method string) lifecycleStep {
	d.plan.t.Helper()
	if ctx != d.plan.ctx || len(d.steps) == 0 || d.steps[0].method != method {
		d.plan.t.Fatalf("unexpected lifecycle call %s: remaining=%+v", method, d.steps)
	}
	step := d.steps[0]
	d.steps = d.steps[1:]
	return step
}

func (d *lifecyclePlanDAO) Refresh(ctx context.Context, hash []byte, lock bool) (store.OAuthRefresh, error) {
	step := d.next(ctx, "refresh")
	if lock != step.lock || !bytes.Equal(hash, secret.Hash(d.plan.token)) {
		d.plan.t.Fatalf("refresh arguments: lock=%v hash=%x", lock, hash)
	}
	return step.refresh, nil
}

func (d *lifecyclePlanDAO) InspectGrant(ctx context.Context, id string, lock bool) (store.OAuthGrant, error) {
	step := d.next(ctx, "grant")
	if lock != step.lock || id != d.plan.grant.ID {
		d.plan.t.Fatalf("grant arguments: id=%s lock=%v", id, lock)
	}
	return step.grant, nil
}

func (d *lifecyclePlanDAO) AccessGrant(ctx context.Context, hash []byte) (string, error) {
	step := d.next(ctx, "access")
	if !bytes.Equal(hash, secret.Hash(d.plan.token)) {
		d.plan.t.Fatalf("access hash=%x", hash)
	}
	return step.grant.ID, nil
}

func (d *lifecyclePlanDAO) OwnerGrants(ctx context.Context, id string) ([]store.OAuthGrant, error) {
	step := d.next(ctx, "list")
	if id != d.plan.grant.UserID {
		d.plan.t.Fatalf("grant list owner=%s want=%s", id, d.plan.grant.UserID)
	}
	return step.grants, nil
}

func (d *lifecyclePlanDAO) FreshTime(ctx context.Context, caller time.Time) (time.Time, error) {
	step := d.next(ctx, "time")
	if !caller.Equal(d.plan.now) {
		d.plan.t.Fatalf("rotation clock=%v want=%v", caller, d.plan.now)
	}
	return step.now, nil
}

func (d *lifecyclePlanDAO) RotateRefresh(ctx context.Context, value store.OAuthRotation) error {
	d.next(ctx, "rotate")
	if value.Grant.ID != d.plan.grant.ID || !bytes.Equal(value.OldHash, secret.Hash(d.plan.token)) || value.AccessID == "" || value.AccessID == value.Grant.ID || !value.CreatedAt.Equal(d.plan.rotationTime) || !value.AccessExpiresAt.Equal(d.plan.rotationTime.Add(AccessLifetime)) {
		d.plan.t.Fatalf("rotation input: %+v", value)
	}
	d.plan.rotation = &value
	return nil
}

func (d *lifecyclePlanDAO) RevokeFamily(ctx context.Context, id string, now time.Time) (bool, error) {
	step := d.next(ctx, "revoke")
	if id != d.plan.grant.ID || !now.Equal(d.plan.now) {
		d.plan.t.Fatalf("replay revocation: id=%s now=%v", id, now)
	}
	d.plan.revocations++
	return step.changed, nil
}

func (p *lifecyclePlan) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	p.t.Helper()
	if ctx != p.ctx || p.active || len(p.writes) == 0 {
		p.t.Fatalf("unexpected lifecycle transaction: count=%d admission=%d", p.transactions, p.admissions)
	}
	write := p.writes[0]
	if write.admitted != (p.admissions == 1) {
		p.t.Fatalf("lifecycle transaction admission=%d want admitted=%v", p.admissions, write.admitted)
	}
	p.writes = p.writes[1:]
	p.transactions++
	p.active = true
	defer func() { p.active = false }()
	dao := &lifecyclePlanDAO{plan: p, steps: write.steps}
	err := fn(dao)
	if !errors.Is(err, write.callbackErr) || len(dao.steps) != 0 {
		p.t.Fatalf("lifecycle callback: err=%v want=%v remaining=%+v", err, write.callbackErr, dao.steps)
	}
	if err != nil {
		return store.Completion{Outcome: write.outcome}, err
	}
	return store.Completion{Outcome: write.outcome}, write.writeErr
}

func (p *lifecyclePlan) admit(ctx context.Context, client string) error {
	p.t.Helper()
	if ctx != p.ctx || client != "client" || p.active || p.transactions != 1 || p.admissions != 0 {
		p.t.Fatalf("admission did not follow completed observation: active=%v transactions=%d admissions=%d client=%s", p.active, p.transactions, p.admissions, client)
	}
	p.admissions++
	return p.admissionErr
}

func lifecycleFixture(t *testing.T) (*lifecyclePlan, *GrantLifecycle) {
	t.Helper()
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "client", Resource: "https://example.test/mcp", Scope: Scope, ExpiresAt: now.Add(GrantLifetime)}
	refresh := store.OAuthRefresh{GrantID: grant.ID, ClientID: "client", ExpiresAt: grant.ExpiresAt}
	p := &lifecyclePlan{t: t, ctx: t.Context(), token: secret.Random(RefreshPrefix), grant: grant, refresh: refresh, now: now, rotationTime: now}
	t.Cleanup(func() {
		if len(p.writes) != 0 {
			t.Errorf("lifecycle omitted %d planned transactions", len(p.writes))
		}
	})
	s := NewGrantLifecycle(p)
	s.now = func() time.Time { return now }
	return p, s
}

func rotationFixture(t *testing.T) (*lifecyclePlan, *GrantLifecycle) {
	t.Helper()
	p, s := lifecycleFixture(t)
	p.writes = []lifecycleWrite{
		{steps: []lifecycleStep{{method: "refresh", refresh: p.refresh}, {method: "grant", grant: p.grant}}, outcome: store.TransactionCommitted},
		{steps: []lifecycleStep{{method: "refresh", refresh: p.refresh}, {method: "grant", lock: true, grant: p.grant}, {method: "refresh", lock: true, refresh: p.refresh}, {method: "time", now: p.now}, {method: "rotate"}}, outcome: store.TransactionCommitted, admitted: true},
	}
	return p, s
}

func TestRotationBindingAndAdmissionBeforeMutation(t *testing.T) {
	for _, mismatch := range []string{"client", "resource", "admission"} {
		t.Run(mismatch, func(t *testing.T) {
			p, s := rotationFixture(t)
			client, resource := p.grant.ClientID, p.grant.Resource
			want := error(ErrInvalidGrant)
			wantAdmissions := 0
			if mismatch == "client" {
				client = "other"
			} else if mismatch == "resource" {
				resource = "https://other.test/mcp"
			} else {
				want = errors.New("admission denied")
				p.admissionErr = want
				wantAdmissions = 1
			}
			p.writes = p.writes[:1]
			if mismatch != "admission" {
				p.writes[0].callbackErr = want
				p.writes[0].outcome = store.TransactionNotCommitted
			}
			result, err := s.Rotate(p.ctx, p.token, client, resource, p.admit)
			if !errors.Is(err, want) || result != (RotatedTokens{}) || p.rotation != nil || p.revocations != 0 || p.admissions != wantAdmissions {
				t.Fatalf("invalid rotation: result=%+v err=%v admissions=%d", result, err, p.admissions)
			}
		})
	}
}

func TestRotationRechecksLockedGrantBeforeMutation(t *testing.T) {
	for _, rejection := range []string{"expired", "revoked"} {
		t.Run(rejection, func(t *testing.T) {
			p, s := rotationFixture(t)
			locked := p.grant
			if rejection == "expired" {
				locked.ExpiresAt = p.now
			} else {
				locked.RevokedAt = &p.now
			}
			p.writes[1].steps[1].grant = locked
			p.writes[1].steps = p.writes[1].steps[:4]
			p.writes[1].callbackErr = ErrInvalidGrant
			p.writes[1].outcome = store.TransactionNotCommitted
			result, err := s.Rotate(p.ctx, p.token, "client", p.grant.Resource, p.admit)
			if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || p.rotation != nil || p.revocations != 0 {
				t.Fatalf("stale grant mutated: result=%+v err=%v", result, err)
			}
		})
	}
}

func TestRotationCommittedResultAndReplayRevocation(t *testing.T) {
	t.Run("committed rotation", func(t *testing.T) {
		p, s := rotationFixture(t)
		result, err := s.Rotate(p.ctx, p.token, "client", p.grant.Resource, p.admit)
		if err != nil || !secret.Valid(result.AccessToken, model.OAuthAccessPrefix) || !secret.Valid(result.RefreshToken, RefreshPrefix) || result.ExpiresIn != int64(AccessLifetime/time.Second) || p.rotation == nil {
			t.Fatalf("committed result: %+v %v", result, err)
		}
		if !bytes.Equal(p.rotation.AccessHash, secret.Hash(result.AccessToken)) || !bytes.Equal(p.rotation.RefreshHash, secret.Hash(result.RefreshToken)) || p.revocations != 0 {
			t.Fatalf("returned secrets differ from requested rotation: %+v", p.rotation)
		}
	})
	t.Run("consumed refresh revokes family", func(t *testing.T) {
		p, s := rotationFixture(t)
		consumed := p.refresh
		consumed.ConsumedAt = &p.now
		p.writes[1].steps[2].refresh = consumed
		p.writes[1].steps[4] = lifecycleStep{method: "revoke", changed: true}
		result, err := s.Rotate(p.ctx, p.token, "client", p.grant.Resource, p.admit)
		if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || p.rotation != nil || p.revocations != 1 {
			t.Fatalf("replay result: %+v err=%v revocations=%d", result, err, p.revocations)
		}
	})
}

func TestGrantLifecycleUnknownDoesNotReturnSecrets(t *testing.T) {
	p, s := rotationFixture(t)
	p.writes[1].outcome = store.TransactionUnknown
	p.writes[1].writeErr = errors.New("lost commit response")
	result, err := s.Rotate(p.ctx, p.token, "client", p.grant.Resource, p.admit)
	if !errors.Is(err, ErrAuthorizationUnknown) || result != (RotatedTokens{}) || p.rotation == nil || p.transactions != 2 {
		t.Fatalf("unknown rotation exposed tokens: result=%+v err=%v transactions=%d", result, err, p.transactions)
	}
}

func TestRotationObservesCandidateAfterWriterCompletion(t *testing.T) {
	cleanup := errors.New("cleanup failure")
	rollback := errors.New("rollback failure")
	unknown := errors.New("commit response lost")
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		cause   error
		want    error
	}{
		{"committed", store.TransactionCommitted, nil, nil},
		{"committed with cleanup error", store.TransactionCommitted, cleanup, cleanup},
		{"not committed", store.TransactionNotCommitted, rollback, rollback},
		{"unknown", store.TransactionUnknown, unknown, ErrAuthorizationUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, s := rotationFixture(t)
			p.writes[1].outcome, p.writes[1].writeErr = tc.outcome, tc.cause
			p.rotationTime = p.now.Add(time.Second + 123456789*time.Nanosecond).In(time.FixedZone("database", 3600))
			p.writes[1].steps[3].now = p.rotationTime
			var observations []RotationObservation
			s.SetRotationObserver(func(ctx context.Context, observation RotationObservation) {
				if ctx != p.ctx || p.active || p.transactions != 2 {
					t.Fatalf("observation before writer completion: active=%v transactions=%d", p.active, p.transactions)
				}
				observations = append(observations, observation)
			})
			result, err := s.Rotate(p.ctx, p.token, p.grant.ClientID, p.grant.Resource, p.admit)
			if !errors.Is(err, tc.want) || (tc.want != nil && result != (RotatedTokens{})) || (tc.want == nil && result.AccessToken == "") {
				t.Fatalf("rotation result=%+v err=%v want=%v", result, err, tc.want)
			}
			wantEvent := model.CredentialUsageEvent{Kind: model.UsageSubjectOAuthGrant, UserID: p.grant.UserID, SubjectID: p.grant.ID, At: p.rotationTime.UTC().Truncate(time.Microsecond)}
			if len(observations) != 1 || observations[0].Event != wantEvent || observations[0].Outcome != tc.outcome || !errors.Is(observations[0].Cause, tc.cause) {
				t.Fatalf("observations=%+v want event=%+v outcome=%s cause=%v", observations, wantEvent, tc.outcome, tc.cause)
			}
		})
	}
}

func TestRotationDoesNotObserveWithoutRealRotation(t *testing.T) {
	for _, scenario := range []string{"replay", "expired", "admission", "rotate failure"} {
		t.Run(scenario, func(t *testing.T) {
			f := newLifecycleFake()
			failure := errors.New("injected failure")
			switch scenario {
			case "replay":
				f.refresh.ConsumedAt = &f.now
			case "expired":
				f.grant.ExpiresAt = f.now
			case "rotate failure":
				f.failures["rotate:1"] = failure
			}
			s := NewGrantLifecycle(f)
			s.SetRotationObserver(func(context.Context, RotationObservation) { t.Error("observed without a successful RotateRefresh") })
			admit := func(context.Context, string) error {
				if scenario == "admission" {
					return failure
				}
				return nil
			}
			result, err := s.Rotate(t.Context(), secret.Random(RefreshPrefix), "client", f.grant.Resource, admit)
			if err == nil || result != (RotatedTokens{}) {
				t.Fatalf("unexpected result=%+v err=%v", result, err)
			}
		})
	}
}

func TestGrantLifecyclePublicAccessAndRefreshRevocation(t *testing.T) {
	for _, prefix := range []string{model.OAuthAccessPrefix, RefreshPrefix} {
		t.Run(prefix, func(t *testing.T) {
			p, s := lifecycleFixture(t)
			p.token = secret.Random(prefix)
			steps := []lifecycleStep{{method: "refresh", refresh: p.refresh}, {method: "grant", lock: true, grant: p.grant}, {method: "refresh", lock: true, refresh: p.refresh}}
			if prefix == model.OAuthAccessPrefix {
				steps[0] = lifecycleStep{method: "access", grant: p.grant}
				steps[2] = lifecycleStep{method: "access", grant: p.grant}
			}
			steps = append(steps, lifecycleStep{method: "time", now: p.now}, lifecycleStep{method: "revoke", changed: true})
			p.writes = []lifecycleWrite{{steps: steps, outcome: store.TransactionCommitted}}
			if err := s.RevokePublic(p.ctx, p.token, p.grant.ClientID); err != nil || p.revocations != 1 || p.rotation != nil {
				t.Fatalf("public revocation: err=%v revocations=%d", err, p.revocations)
			}
		})
	}
}

func TestGrantLifecycleOwnerListAndRevocation(t *testing.T) {
	t.Run("owner list", func(t *testing.T) {
		p, s := lifecycleFixture(t)
		p.writes = []lifecycleWrite{{steps: []lifecycleStep{{method: "list", grants: []store.OAuthGrant{p.grant}}}, outcome: store.TransactionCommitted}}
		items, err := s.ListOwnerGrants(p.ctx, p.grant.UserID)
		if err != nil || len(items) != 1 || items[0].ID != p.grant.ID || items[0].UserID != p.grant.UserID || p.revocations != 0 {
			t.Fatalf("owner list: %+v err=%v", items, err)
		}
	})
	t.Run("owner revocation and unchanged result", func(t *testing.T) {
		p, s := lifecycleFixture(t)
		for _, changed := range []bool{true, false} {
			p.writes = append(p.writes, lifecycleWrite{steps: []lifecycleStep{{method: "grant", lock: true, grant: p.grant}, {method: "time", now: p.now}, {method: "revoke", changed: changed}}, outcome: store.TransactionCommitted})
		}
		for _, want := range []bool{true, false} {
			changed, err := s.RevokeOwnerGrant(p.ctx, p.grant.UserID, p.grant.ID)
			if err != nil || changed != want {
				t.Fatalf("owner revocation: changed=%v want=%v err=%v", changed, want, err)
			}
		}
		if p.revocations != 2 {
			t.Fatalf("owner revocation calls=%d", p.revocations)
		}
	})
	t.Run("foreign owner", func(t *testing.T) {
		p, s := lifecycleFixture(t)
		p.writes = []lifecycleWrite{{steps: []lifecycleStep{{method: "grant", lock: true, grant: p.grant}}, callbackErr: model.ErrNotFound, outcome: store.TransactionNotCommitted}}
		changed, err := s.RevokeOwnerGrant(p.ctx, uuid.NewString(), p.grant.ID)
		if !errors.Is(err, model.ErrNotFound) || changed || p.revocations != 0 {
			t.Fatalf("foreign owner revoked grant: changed=%v err=%v revocations=%d", changed, err, p.revocations)
		}
	})
}
