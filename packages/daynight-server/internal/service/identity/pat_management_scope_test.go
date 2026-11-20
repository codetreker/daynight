package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type scopedPatDAO struct {
	*patDAO
	store.PATScopeDAO
	t            *testing.T
	ctx          context.Context
	user         string
	items        []model.PersonalAccessToken
	locked       model.PersonalAccessToken
	updated      model.PersonalAccessToken
	compareCalls int
}

func (d *scopedPatDAO) ListPATScopes(ctx context.Context, user string) ([]model.PersonalAccessToken, error) {
	if d.t == nil {
		panic("unexpected PAT list")
	}
	if ctx != d.ctx || user != d.user {
		d.t.Fatalf("unexpected list context or user: %v %q", ctx, user)
	}
	d.calls = append(d.calls, "list")
	return d.items, nil
}

func (d *scopedPatDAO) LockPATScope(_ context.Context, user, id string) (model.PersonalAccessToken, error) {
	if d.locked.ID == "" || user != d.locked.UserID || id != d.locked.ID {
		panic("unexpected PAT lock")
	}
	d.calls = append(d.calls, "target")
	return d.locked, nil
}
func (d *scopedPatDAO) ComparePATScope(_ context.Context, user, id string, version int64, scopes []scopepolicy.ScopeID, _ time.Time) (model.PersonalAccessToken, error) {
	if user != d.locked.UserID || id != d.locked.ID || version != d.locked.ScopePolicy.Version() || !reflect.DeepEqual(scopes, []scopepolicy.ScopeID{"task:read"}) {
		panic("unexpected PAT compare")
	}
	d.calls = append(d.calls, "compare")
	d.compareCalls++
	return d.updated, nil
}

type identityOnlyDAO struct{ store.IdentityDAO }
type arbitraryIdentityScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s arbitraryIdentityScope) IdentityDAO() store.IdentityDAO { return s.dao }

func TestScopedPATMissingCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name     string
		dao      store.IdentityDAO
		expected string
	}{
		{"management", identityOnlyDAO{}, "identity scope lacks PAT management capability"},
		{"scopes", &patDAO{}, "identity scope lacks PAT scope capability"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, err := scopedPAT(arbitraryIdentityScope{dao: tc.dao})
			if err == nil || err.Error() != tc.expected {
				t.Fatalf("error %v", err)
			}
		})
	}
}

type scopedPatScope struct{ dao *scopedPatDAO }

func (s scopedPatScope) IdentityDAO() store.IdentityDAO                 { return s.dao }
func (s scopedPatScope) CredentialFamilyDAO() store.CredentialFamilyDAO { panic("unexpected family") }
func (s scopedPatScope) PersonalTeamDAO() store.PersonalTeamDAO         { panic("unexpected team") }

type scopedPatWriter struct {
	dao      *scopedPatDAO
	outcome  store.TransactionOutcome
	callback error
}

func TestUpdateScopedPATTransactionAndRefusals(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read", "project:read"})
	if err != nil {
		t.Fatal(err)
	}
	oldPolicy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read"}, 1)
	newPolicy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 2)
	id := uuid.NewString()
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionUnknown} {
		d := &scopedPatDAO{patDAO: &patDAO{}, locked: model.PersonalAccessToken{ID: id, UserID: p.UserID, ScopePolicy: &oldPolicy}, updated: model.PersonalAccessToken{ID: id, UserID: p.UserID, ScopePolicy: &newPolicy}}
		w := &scopedPatWriter{dao: d, outcome: outcome}
		svc := NewWithDeviceScopes(w, nil, "", catalog)
		result, err := svc.UpdateScopedPAT(t.Context(), p, id, p.UserID, 1, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"})
		if d.compareCalls != 1 || !reflect.DeepEqual(d.calls, []string{"lock", "target", "fresh", "lock", "compare"}) {
			t.Fatalf("calls %v", d.calls)
		}
		if outcome == store.TransactionCommitted && (err != nil || result.ID != id || result.ScopePolicy.Version() != 2) {
			t.Fatalf("committed %+v %v", result, err)
		}
		if outcome == store.TransactionUnknown {
			var tx *store.TransactionError
			if result.ID != "" || !errors.As(err, &tx) || tx.Outcome != store.TransactionUnknown {
				t.Fatalf("unknown %+v %v", result, err)
			}
		}
	}
	d := &scopedPatDAO{patDAO: &patDAO{}, locked: model.PersonalAccessToken{ID: id, UserID: p.UserID, ScopePolicy: &oldPolicy}}
	w := &scopedPatWriter{dao: d, outcome: store.TransactionCommitted}
	svc := NewWithDeviceScopes(w, nil, "", catalog)
	for _, tc := range []struct {
		name, expected, revision, code string
		version                        int64
	}{
		{"different account", uuid.NewString(), catalog.CatalogRevision, "forbidden", 1},
		{"stale catalog", p.UserID, "stale", "version_conflict", 1},
		{"stale policy", p.UserID, catalog.CatalogRevision, "version_conflict", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d.calls = nil
			result, err := svc.UpdateScopedPAT(t.Context(), p, id, tc.expected, tc.version, tc.revision, []scopepolicy.ScopeID{"task:read"})
			var fault *model.Fault
			if result.ID != "" || !errors.As(err, &fault) || fault.Code != tc.code || d.compareCalls != 0 {
				t.Fatalf("result %+v err %v calls %v", result, err, d.calls)
			}
		})
	}
	withoutCatalog := New(w, nil, "")
	if _, err := withoutCatalog.UpdateScopedPAT(t.Context(), p, id, p.UserID, 1, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"}); err == nil {
		t.Fatal("missing catalog accepted")
	}
}

func (w *scopedPatWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.callback = fn(scopedPatScope{w.dao})
	if w.callback != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, w.callback
	}
	return store.Completion{Outcome: w.outcome}, nil
}

func TestScopedPATCreateAndRead(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"team:read", "team:write", "task:read"})
	if err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionUnknown} {
		d := &scopedPatDAO{patDAO: &patDAO{}}
		w := &scopedPatWriter{dao: d, outcome: outcome}
		svc := NewWithDeviceScopes(w, nil, "", catalog)
		result, err := svc.CreateScopedPAT(t.Context(), p, p.UserID, core.CreatePAT{Name: "test"}, nil, catalog.CatalogRevision, catalog.DefaultScopes)
		if d.minted.ScopePolicy == nil || !reflect.DeepEqual(d.minted.ScopePolicy.Scopes(), catalog.DefaultScopes) || d.minted.ScopePolicy.Version() != 1 {
			t.Fatalf("stored policy: %#v", d.minted.ScopePolicy)
		}
		if outcome == store.TransactionCommitted && (err != nil || result.Secret == "") {
			t.Fatalf("confirmed create: %v", err)
		}
		if outcome == store.TransactionUnknown {
			var tx *store.TransactionError
			if result.Secret != "" || !errors.As(err, &tx) || tx.Outcome != store.TransactionUnknown {
				t.Fatalf("unknown create: %v", err)
			}
		}
	}
	d := &scopedPatDAO{patDAO: &patDAO{}}
	w := &scopedPatWriter{dao: d, outcome: store.TransactionCommitted}
	svc := NewWithDeviceScopes(w, nil, "", catalog)
	for _, tc := range []struct {
		user, rev string
		ids       []scopepolicy.ScopeID
		code      string
	}{
		{uuid.NewString(), catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"}, "forbidden"},
		{p.UserID, "stale", []scopepolicy.ScopeID{"task:read"}, "version_conflict"},
		{p.UserID, catalog.CatalogRevision, []scopepolicy.ScopeID{"project:read"}, "invalid_input"},
		{p.UserID, catalog.CatalogRevision, nil, "invalid_input"},
	} {
		_, err := svc.CreateScopedPAT(t.Context(), p, tc.user, core.CreatePAT{Name: "x"}, nil, tc.rev, tc.ids)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != tc.code || len(d.calls) != 0 {
			t.Fatalf("refusal %s: %v calls %v", tc.code, err, d.calls)
		}
	}
	old := time.Now().Add(-time.Hour)
	policy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	d.items = []model.PersonalAccessToken{{ID: uuid.NewString(), UserID: p.UserID, ExpiresAt: &old, ScopePolicy: &policy}}
	ctx := t.Context()
	d.t, d.ctx, d.user = t, ctx, p.UserID
	items, err := svc.ListScopedPATs(ctx, p)
	if err != nil || len(items) != 1 || items[0].ExpiresAt == nil || !reflect.DeepEqual(d.calls, []string{"lock", "list", "fresh", "lock"}) {
		t.Fatalf("list %v %v %v", items, err, d.calls)
	}
}
