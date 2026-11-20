package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type scopeReceiver struct {
	store.PATScopeDAO
	store.PATManagementDAO
	t          *testing.T
	ctx        context.Context
	p          model.Principal
	token      model.PersonalAccessToken
	now, fresh time.Time
	hash       []byte
	calls      []string
	err        error
	clockErr   error
	writeErr   error
}

func (d *scopeReceiver) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || !reflect.DeepEqual(hash, d.hash) || now != d.now {
		d.t.Fatal("unexpected hash lookup")
	}
	d.calls = append(d.calls, "hash")
	return d.token, d.err
}
func (d *scopeReceiver) LockPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || user != d.p.UserID || id != d.token.ID {
		d.t.Fatal("unexpected target lock")
	}
	d.calls = append(d.calls, "target")
	return d.token, d.err
}
func (d *scopeReceiver) ReadLockedPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || user != d.p.UserID || id != d.token.ID {
		d.t.Fatal("unexpected authorization lock")
	}
	d.calls = append(d.calls, "read-target")
	return d.token, d.err
}
func (d *scopeReceiver) FreshPATTime(ctx context.Context, now time.Time) (time.Time, error) {
	if ctx != d.ctx || now != d.now {
		d.t.Fatal("unexpected clock input")
	}
	d.calls = append(d.calls, "time")
	return d.fresh, d.clockErr
}
func (d *scopeReceiver) ComparePATScope(ctx context.Context, user, id string, version int64, scopes []scopepolicy.ScopeID, now time.Time) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || user != d.p.UserID || id != d.token.ID || version != 3 || !reflect.DeepEqual(scopes, []scopepolicy.ScopeID{"project:read", "task:read"}) || now != d.fresh {
		d.t.Fatal("unexpected scope write")
	}
	d.calls = append(d.calls, "write")
	return d.token, d.writeErr
}

type scopeSessionReceiver struct {
	store.IdentityDAO
	t        *testing.T
	ctx      context.Context
	p        model.Principal
	scope    *scopeReceiver
	calls    int
	err      error
	firstErr error
}

func (d *scopeSessionReceiver) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	if ctx != d.ctx || p != d.p {
		d.t.Fatal("unexpected session")
	}
	if d.calls == 0 && now != d.scope.now || d.calls == 1 && now != d.scope.fresh || d.calls > 1 {
		d.t.Fatal("unexpected session time or count")
	}
	d.calls++
	d.scope.calls = append(d.scope.calls, "session")
	if d.calls == 1 {
		return d.firstErr
	}
	if d.calls == 2 {
		return d.err
	}
	return nil
}

func TestPATPolicyReadsAndEdit(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fresh := now.Add(time.Minute)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	token := model.PersonalAccessToken{ID: uuid.NewString(), UserID: p.UserID, ScopePolicy: &policy}
	value := secret.Random("dnpat_")
	newScope := func() *scopeReceiver {
		return &scopeReceiver{t: t, ctx: ctx, p: p, token: token, now: now, fresh: fresh, hash: secret.Hash(value)}
	}
	module := NewIdentity("")

	t.Run("hash and locked identity", func(t *testing.T) {
		d := newScope()
		a, err := module.AuthenticatePATPolicy(ctx, d, value, now)
		if err != nil || a.Principal.UserID != p.UserID || a.Principal.CredentialID != token.ID || a.Policy.Version() != 3 {
			t.Fatalf("authorization=%#v err=%v", a, err)
		}
		pat := a.Principal
		a, err = module.LockPATAuthorization(ctx, d, d, pat, now)
		if err != nil || a.Policy.Version() != 3 || !reflect.DeepEqual(d.calls, []string{"hash", "read-target", "time"}) {
			t.Fatalf("authorization=%#v calls=%v err=%v", a, d.calls, err)
		}
	})
	t.Run("invalid and missing persisted policy fail closed", func(t *testing.T) {
		d := newScope()
		if _, err := module.AuthenticatePATPolicy(ctx, d, "invalid", now); err == nil || len(d.calls) != 0 {
			t.Fatal("invalid secret touched the store")
		}
		d.token.ScopePolicy = nil
		if _, err := module.AuthenticatePATPolicy(ctx, d, value, now); err == nil {
			t.Fatal("missing policy accepted")
		}
		d.err = model.ErrNotFound
		_, err := module.AuthenticatePATPolicy(ctx, d, value, now)
		checkFault(t, err, "unauthenticated")
	})
	t.Run("locked credential expired while waiting", func(t *testing.T) {
		d := newScope()
		d.token.ExpiresAt = &fresh
		pat := model.Principal{Kind: model.PATCredential, UserID: p.UserID, CredentialID: token.ID}
		_, err := module.LockPATAuthorization(ctx, d, d, pat, now)
		checkFault(t, err, "unauthenticated")
		if !reflect.DeepEqual(d.calls, []string{"read-target", "time"}) {
			t.Fatalf("calls=%v", d.calls)
		}
	})
	for _, tc := range []struct {
		name       string
		expected   int64
		expiry     *time.Time
		sessionErr error
		code       string
		write      bool
	}{
		{name: "updated", expected: 3, write: true},
		{name: "stale", expected: 2, code: "version_conflict"},
		{name: "expired after lock", expected: 3, expiry: &fresh, code: "not_found"},
		{name: "session expired", expected: 3, sessionErr: model.ErrNotFound, code: "unauthenticated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newScope()
			d.token.ExpiresAt = tc.expiry
			session := &scopeSessionReceiver{t: t, ctx: ctx, p: p, scope: d, err: tc.sessionErr}
			_, err := module.UpdatePATScope(ctx, session, d, d, p, token.ID, p.UserID, tc.expected, []scopepolicy.ScopeID{"task:read", "project:read"}, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if err != nil {
				t.Fatal(err)
			}
			want := []string{"session", "target", "time", "session"}
			if tc.write {
				want = append(want, "write")
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatalf("calls=%v want=%v", d.calls, want)
			}
		})
	}
	t.Run("invalid request does not read or write", func(t *testing.T) {
		for _, ids := range [][]scopepolicy.ScopeID{nil, {"task:read", "task:read"}, {"unknown"}} {
			d := newScope()
			session := &scopeSessionReceiver{t: t, ctx: ctx, p: p, scope: d}
			_, err := module.UpdatePATScope(ctx, session, d, d, p, token.ID, p.UserID, 3, ids, now)
			checkFault(t, err, "invalid_input")
			if len(d.calls) != 0 {
				t.Fatalf("invalid request touched DAO: %v", d.calls)
			}
		}
	})
}

func TestPATScopeFailurePaths(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	token := model.PersonalAccessToken{ID: uuid.NewString(), UserID: p.UserID, ScopePolicy: &policy}
	pat := model.Principal{Kind: model.PATCredential, UserID: p.UserID, CredentialID: token.ID}
	failure := errors.New("store failure")
	module := NewIdentity("")

	t.Run("authorization rejects invalid principal before storage", func(t *testing.T) {
		for _, invalid := range []model.Principal{p, {Kind: model.PATCredential, UserID: p.UserID}} {
			d := &scopeReceiver{t: t, ctx: ctx, p: p, token: token, now: now, fresh: now.Add(time.Second)}
			_, err := module.LockPATAuthorization(ctx, d, d, invalid, now)
			checkFault(t, err, "unauthenticated")
			if len(d.calls) != 0 {
				t.Fatalf("invalid principal touched storage: %v", d.calls)
			}
		}
	})
	for _, tc := range []struct {
		name              string
		readErr, clockErr error
		code              string
		cause             error
		calls             []string
	}{
		{name: "revoked", readErr: model.ErrNotFound, code: "unauthenticated", calls: []string{"read-target"}},
		{name: "read failure", readErr: failure, cause: failure, calls: []string{"read-target"}},
		{name: "clock failure", clockErr: failure, cause: failure, calls: []string{"read-target", "time"}},
	} {
		t.Run("authorization "+tc.name, func(t *testing.T) {
			d := &scopeReceiver{t: t, ctx: ctx, p: p, token: token, now: now, fresh: now.Add(time.Second), err: tc.readErr, clockErr: tc.clockErr}
			_, err := module.LockPATAuthorization(ctx, d, d, pat, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if !errors.Is(err, tc.cause) {
				t.Fatalf("lost cause: %v", err)
			}
			if !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("calls=%v", d.calls)
			}
		})
	}
	for _, tc := range []struct {
		name                                  string
		principal                             model.Principal
		id, expectedUser                      string
		expected                              int64
		firstErr, readErr, clockErr, writeErr error
		missingPolicy                         bool
		code                                  string
		cause                                 error
		calls                                 []string
	}{
		{name: "different account", principal: p, id: token.ID, expectedUser: uuid.NewString(), expected: 3, code: "forbidden"},
		{name: "invalid target", principal: p, id: "bad", expectedUser: p.UserID, expected: 3, code: "invalid_input"},
		{name: "invalid version", principal: p, id: token.ID, expectedUser: p.UserID, expected: 0, code: "invalid_input"},
		{name: "session revoked", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, firstErr: model.ErrNotFound, code: "unauthenticated", calls: []string{"session"}},
		{name: "target revoked", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, readErr: model.ErrNotFound, code: "not_found", calls: []string{"session", "target"}},
		{name: "target read failed", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, readErr: failure, cause: failure, calls: []string{"session", "target"}},
		{name: "clock failed", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, clockErr: failure, cause: failure, calls: []string{"session", "target", "time"}},
		{name: "invalid saved policy", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, missingPolicy: true, calls: []string{"session", "target", "time", "session"}},
		{name: "write failed", principal: p, id: token.ID, expectedUser: p.UserID, expected: 3, writeErr: failure, cause: failure, calls: []string{"session", "target", "time", "session", "write"}},
	} {
		t.Run("edit "+tc.name, func(t *testing.T) {
			d := &scopeReceiver{t: t, ctx: ctx, p: p, token: token, now: now, fresh: now.Add(time.Second), err: tc.readErr, clockErr: tc.clockErr, writeErr: tc.writeErr}
			if tc.missingPolicy {
				d.token.ScopePolicy = nil
			}
			session := &scopeSessionReceiver{t: t, ctx: ctx, p: p, scope: d, firstErr: tc.firstErr}
			_, err := module.UpdatePATScope(ctx, session, d, d, tc.principal, tc.id, tc.expectedUser, tc.expected, []scopepolicy.ScopeID{"task:read", "project:read"}, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if tc.cause != nil {
				if !errors.Is(err, tc.cause) {
					t.Fatalf("lost cause: %v", err)
				}
			} else if err == nil {
				t.Fatal("invalid saved policy accepted")
			}
			if !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("calls=%v want=%v", d.calls, tc.calls)
			}
		})
	}
}

func TestPATScopeEditChecksCatalogAgainstLockedPolicy(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 3)
	token := model.PersonalAccessToken{ID: uuid.NewString(), UserID: p.UserID, ScopePolicy: &policy}
	for _, tc := range []struct {
		name      string
		available []scopepolicy.ScopeID
		code      string
	}{
		{"retain unavailable", []scopepolicy.ScopeID{"project:read"}, ""},
		{"unavailable addition", []scopepolicy.ScopeID{"task:read"}, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, tc.available)
			if err != nil {
				t.Fatal(err)
			}
			d := &scopeReceiver{t: t, ctx: ctx, p: p, token: token, now: now, fresh: now.Add(time.Second)}
			session := &scopeSessionReceiver{t: t, ctx: ctx, p: p, scope: d}
			_, err = NewIdentity("").UpdatePATScopeWithCatalog(ctx, session, d, d, p, token.ID, p.UserID, 3, []scopepolicy.ScopeID{"task:read", "project:read"}, catalog, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if err != nil {
				t.Fatal(err)
			}
			want := []string{"session", "target", "time", "session"}
			if tc.code == "" {
				want = append(want, "write")
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatalf("calls %v", d.calls)
			}
		})
	}
}
