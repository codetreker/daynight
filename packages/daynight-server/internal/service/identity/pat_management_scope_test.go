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
	items []model.PersonalAccessToken
}

func (d *scopedPatDAO) ListPATScopes(context.Context, string) ([]model.PersonalAccessToken, error) {
	d.calls = append(d.calls, "list")
	return d.items, nil
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
	items, err := svc.ListScopedPATs(t.Context(), p)
	if err != nil || len(items) != 1 || items[0].ExpiresAt == nil || !reflect.DeepEqual(d.calls, []string{"lock", "list", "fresh", "lock"}) {
		t.Fatalf("list %v %v %v", items, err, d.calls)
	}
}
