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
	grants []store.OAuthGrant
}

func (d *managementDAO) LockOwnerSession(ctx context.Context, p model.Principal, now time.Time) error {
	return d.scopeFake.LockOwnerSession(ctx, p, now)
}
func (d *managementDAO) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	return d.scopeFake.FreshTime(ctx, now)
}
func (d *managementDAO) ScopedOwnerGrants(_ context.Context, user string) ([]store.OAuthGrant, error) {
	if user != d.grant.UserID {
		return nil, errors.New("wrong owner")
	}
	return d.grants, nil
}

type managementWriter struct {
	dao     *managementDAO
	outcome store.TransactionOutcome
	calls   int
}

func (w *managementWriter) WriteGrantLifecycle(_ context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	w.calls++
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
