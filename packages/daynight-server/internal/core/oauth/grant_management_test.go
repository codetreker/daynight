package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type managementDAO struct {
	store.GrantLifecycleDAO
	*scopeFake
	grants    []store.OAuthGrant
	listErr   error
	listCalls int
}

func (d *managementDAO) LockOwnerSession(ctx context.Context, p model.Principal, now time.Time) error {
	return d.scopeFake.LockOwnerSession(ctx, p, now)
}
func (d *managementDAO) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	return d.scopeFake.FreshTime(ctx, now)
}
func (d *managementDAO) ScopedOwnerGrants(ctx context.Context, user string) ([]store.OAuthGrant, error) {
	d.listCalls++
	if ctx != d.expectedContext || user != d.grant.UserID || d.listCalls > 1 {
		d.t.Errorf("unexpected grant list: context=%v owner=%s call=%d", ctx == d.expectedContext, user, d.listCalls)
		return nil, errors.New("unexpected grant list")
	}
	return d.grants, d.listErr
}

type managementWriter struct {
	dao     *managementDAO
	outcome store.TransactionOutcome
	calls   int
}

func (w *managementWriter) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	w.calls++
	if ctx != w.dao.expectedContext || w.calls > 1 {
		w.dao.t.Errorf("unexpected transaction: context=%v call=%d", ctx == w.dao.expectedContext, w.calls)
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unexpected transaction")
	}
	err := fn(w.dao)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: w.outcome}, nil
}

func TestScopedGrantManagement(t *testing.T) {
	for _, tc := range []struct {
		name     string
		selected []scopepolicy.ScopeID
		version  int64
		revision string
		outcome  store.TransactionOutcome
		code     string
	}{
		{"retain unavailable", []scopepolicy.ScopeID{"task:read", "project:read"}, 3, "current", store.TransactionCommitted, ""},
		{"remove unavailable", []scopepolicy.ScopeID{"project:read"}, 3, "current", store.TransactionCommitted, ""},
		{"add unavailable", []scopepolicy.ScopeID{"team:read"}, 3, "current", store.TransactionCommitted, "invalid_input"},
		{"stale", []scopepolicy.ScopeID{"project:read"}, 2, "current", store.TransactionCommitted, "version_conflict"},
		{"catalog changed", []scopepolicy.ScopeID{"project:read"}, 3, "stale", store.TransactionCommitted, "version_conflict"},
		{"empty", nil, 3, "current", store.TransactionCommitted, "invalid_input"},
		{"unknown commit", []scopepolicy.ScopeID{"project:read"}, 3, "current", store.TransactionUnknown, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, p := scopeTestFake(t)
			f.grant.ClientID = "client"
			f.grant.ClientSnapshot = []byte(`{"clientId":"client"}`)
			catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"project:read"})
			if err != nil {
				t.Fatal(err)
			}
			dao := &managementDAO{scopeFake: f, grants: []store.OAuthGrant{f.grant}}
			w := &managementWriter{dao: dao, outcome: tc.outcome}
			life := NewGrantLifecycle(w)
			life.now = func() time.Time { return f.now }
			manager, err := NewScopedGrantManagement(life, catalog)
			if err != nil {
				t.Fatal(err)
			}
			revision := tc.revision
			if revision == "current" {
				revision = catalog.CatalogRevision
			}
			got, _, err := manager.UpdateSessionGrantScope(t.Context(), p, p.UserID, f.grant.ID, tc.version, revision, tc.selected)
			if tc.code == "unknown" {
				if !errors.Is(err, ErrAuthorizationUnknown) || got.ID != "" {
					t.Fatalf("unknown = %+v, %v", got, err)
				}
			} else if tc.code != "" {
				scopeFault(t, err, tc.code)
			} else if err != nil || got.ID != f.grant.ID {
				t.Fatalf("result = %+v, %v", got, err)
			}
			if tc.name == "catalog changed" && w.calls != 0 {
				t.Fatal("stale catalog reached store")
			}
			if tc.code == "invalid_input" || tc.code == "version_conflict" {
				if len(f.selected) != 0 {
					t.Fatal("invalid write reached storage")
				}
			} else if !reflect.DeepEqual(f.selected, tc.selected) { // selections here use canonical order except for the first case
				if tc.name != "retain unavailable" || !reflect.DeepEqual(f.selected, []scopepolicy.ScopeID{"project:read", "task:read"}) {
					t.Fatalf("selected %v", f.selected)
				}
			}
		})
	}
}

func TestScopedGrantListAndCatalogBinding(t *testing.T) {
	f, p := scopeTestFake(t)
	f.fresh = f.now
	dao := &managementDAO{scopeFake: f, grants: []store.OAuthGrant{f.grant}}
	w := &managementWriter{dao: dao, outcome: store.TransactionCommitted}
	life := NewGrantLifecycle(w)
	life.now = func() time.Time { return f.now }
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewScopedGrantManagement(life, catalog)
	if err != nil {
		t.Fatal(err)
	}
	items, observed, err := s.ListSessionGrants(t.Context(), p)
	if err != nil || len(items) != 1 || items[0].ID != f.grant.ID || !observed.Equal(f.now) || f.sessionCalls != 2 {
		t.Fatalf("list = %+v, %v, %v", items, observed, err)
	}
	pat, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = NewScopedGrantManagement(life, pat); err == nil {
		t.Fatal("PAT catalog accepted for MCP grants")
	}
}

func TestScopedGrantListRefusalsAndFailures(t *testing.T) {
	failure := errors.New("grant store unavailable")
	for _, tc := range []struct {
		name      string
		change    func(*scopeFake, *managementDAO, *managementWriter, *model.Principal)
		wantCode  string
		wantErr   error
		wantCalls int
		wantReads int
	}{
		{"non-session actor", func(_ *scopeFake, _ *managementDAO, _ *managementWriter, p *model.Principal) {
			p.Kind = model.PATCredential
		}, "unauthenticated", nil, 0, 0},
		{"session expired before read", func(f *scopeFake, _ *managementDAO, _ *managementWriter, _ *model.Principal) {
			f.firstSessionErr = model.ErrNotFound
		}, "unauthenticated", nil, 1, 0},
		{"storage failure", func(_ *scopeFake, d *managementDAO, _ *managementWriter, _ *model.Principal) { d.listErr = failure }, "", failure, 1, 1},
		{"session expired after read", func(f *scopeFake, _ *managementDAO, _ *managementWriter, _ *model.Principal) {
			f.sessionErr = model.ErrNotFound
		}, "unauthenticated", nil, 1, 1},
		{"unknown transaction outcome", func(_ *scopeFake, _ *managementDAO, w *managementWriter, _ *model.Principal) {
			w.outcome = store.TransactionUnknown
		}, "", ErrAuthorizationUnknown, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, p := scopeTestFake(t)
			f.fresh = f.now
			dao := &managementDAO{scopeFake: f, grants: []store.OAuthGrant{f.grant}}
			w := &managementWriter{dao: dao, outcome: store.TransactionCommitted}
			life := NewGrantLifecycle(w)
			life.now = func() time.Time { return f.now }
			catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
			if err != nil {
				t.Fatal(err)
			}
			manager, err := NewScopedGrantManagement(life, catalog)
			if err != nil {
				t.Fatal(err)
			}
			tc.change(f, dao, w, &p)
			grants, observed, err := manager.ListSessionGrants(t.Context(), p)
			if tc.wantCode != "" {
				scopeFault(t, err, tc.wantCode)
			} else if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error = %v, want %v", err, tc.wantErr)
			}
			if grants != nil || !observed.IsZero() || w.calls != tc.wantCalls || dao.listCalls != tc.wantReads {
				t.Fatalf("grants=%v observed=%v transactions=%d reads=%d", grants, observed, w.calls, dao.listCalls)
			}
		})
	}
}
