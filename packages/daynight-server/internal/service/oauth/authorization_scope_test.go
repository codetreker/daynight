package oauth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func scopeCatalog(t *testing.T) scopepolicy.CatalogSnapshot {
	t.Helper()
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read", "task:write", "team:read", "worker:complete"})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestScopedAuthorizationConstructorOwnsCatalogAndRejectsLegacyApproval(t *testing.T) {
	f := newOAuthFixture(t)
	catalog := scopeCatalog(t)
	s, err := NewAuthorizationsWithScopes(f, f.clients(), core.PublicAdmission{}, "https://server.example", catalog)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Groups[0].ScopeIDs[0] = "task:delete"
	snapshot, enabled := s.ScopeCatalog()
	if !enabled || snapshot.Groups[0].ScopeIDs[0] != "task:read" {
		t.Fatal("catalog aliases constructor input")
	}
	snapshot.Groups[0].ScopeIDs[0] = "task:delete"
	snapshot, _ = s.ScopeCatalog()
	if snapshot.Groups[0].ScopeIDs[0] != "task:read" {
		t.Fatal("catalog read aliases service")
	}
	record := fixtureAuthorization(uuid.NewString(), f.now)
	before := cloneAuthorization(record)
	if _, err := s.operations.decide(&record, secret.Random(core.BindingPrefix), "approve", uuid.NewString(), s.issuer, f.now); !errors.Is(err, core.ErrInvalidAuthorization) {
		t.Fatal(err)
	}
	f.equal(record, before)
	if _, err = NewAuthorizationsWithScopes(nil, f.clients(), core.PublicAdmission{}, "https://server.example", snapshot); err == nil {
		t.Fatal("invalid constructor accepted")
	}
}

func TestScopedAuthorizationInspectionRequiresCatalog(t *testing.T) {
	f := newOAuthFixture(t)
	s := f.service()
	if _, enabled := s.ScopeCatalog(); enabled {
		t.Fatal("legacy issuer advertised scoped approval")
	}
	if _, err := s.InspectV2(f.ctx, uuid.NewString(), secret.Random(core.BindingPrefix), fixturePrincipal()); err == nil {
		t.Fatal("inspection succeeded without catalog")
	}
}

func TestScopedAuthorizationInspectionResumesOriginalRequestWithoutTerminalChoices(t *testing.T) {
	for _, status := range []string{"pending", "approved", "denied", "expired", "consumed"} {
		t.Run(status, func(t *testing.T) {
			f := newOAuthFixture(t, inspectionSteps()...)
			s := f.service()
			catalog := scopeCatalog(t)
			s.catalog = &catalog
			p := fixturePrincipal()
			record := fixtureAuthorization(uuid.NewString(), f.now)
			configureInspection(f, s, record.ID, "browser-binding", p, record, f.now)
			s.operations.status = func(a store.OAuthAuthorization, now time.Time) (string, bool) {
				f.step("status")
				return status, status == "approved"
			}
			f.plan("authorization", true, nil, store.TransactionCommitted, nil)
			got, err := s.InspectV2(f.ctx, record.ID, "browser-binding", p)
			if err != nil {
				t.Fatal(err)
			}
			if got.RequestID != record.ID || got.Status != status || got.UserID != p.UserID || got.Scope != core.Scope {
				t.Fatalf("view changed: %+v", got)
			}
			if (got.CatalogRevision != nil) != (status == "pending") {
				t.Fatalf("terminal catalog: %+v", got)
			}
			if got.CatalogRevision != nil && *got.CatalogRevision != catalog.CatalogRevision {
				t.Fatal("wrong catalog")
			}
		})
	}
}

func TestScopedAuthorizationDecisionRejectsInvalidInputsBeforeTransaction(t *testing.T) {
	for _, mode := range []string{"catalog unavailable", "principal", "account", "binding", "revision", "empty", "unknown", "unavailable", "duplicate", "denial scopes", "denial revision"} {
		t.Run(mode, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			catalog := scopeCatalog(t)
			s.catalog = &catalog
			p := fixturePrincipal()
			in := ScopedDecisionInput{DecisionInput: DecisionInput{RequestID: uuid.NewString(), Binding: secret.Random(core.BindingPrefix), ExpectedUserID: p.UserID, Decision: "approve", Principal: p}, CatalogRevision: catalog.CatalogRevision, Scopes: []scopepolicy.ScopeID{"task:read"}}
			switch mode {
			case "catalog unavailable":
				s.catalog = nil
			case "principal":
				in.Principal = model.Principal{}
			case "account":
				in.ExpectedUserID = uuid.NewString()
			case "binding":
				in.Binding = "bad"
			case "revision":
				in.CatalogRevision = "old"
			case "empty":
				in.Scopes = nil
			case "unknown":
				in.Scopes = []scopepolicy.ScopeID{"unknown"}
			case "unavailable":
				in.Scopes = []scopepolicy.ScopeID{"task:delete"}
			case "duplicate":
				in.Scopes = []scopepolicy.ScopeID{"task:read", "task:read"}
			case "denial scopes":
				in.Decision = "deny"
				in.CatalogRevision = ""
			case "denial revision":
				in.Decision = "deny"
				in.Scopes = nil
			}
			got, err := s.DecideV2(f.ctx, in)
			if err == nil || got.RedirectURI != "" {
				t.Fatalf("accepted %s", mode)
			}
			if mode == "revision" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "version_conflict" {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestScopedAuthorizationDecisionWritesSelectionWithOriginalTransaction(t *testing.T) {
	for _, mode := range []string{"approved", "denied", "unknown", "expired", "wrong binding", "terminal", "session expired", "update failure"} {
		t.Run(mode, func(t *testing.T) {
			steps := []string{"writer authorization", "scope authorization", "scope identity", "lock session", "read authorization", "fresh", "scope identity", "lock session"}
			if mode != "expired" && mode != "wrong binding" && mode != "terminal" && mode != "session expired" {
				steps = append(steps, "update authorization")
			}
			steps = append(steps, "callback returned", "writer returned")
			f := newOAuthFixture(t, steps...)
			s := f.service()
			catalog := scopeCatalog(t)
			s.catalog = &catalog
			p := fixturePrincipal()
			binding := secret.Random(core.BindingPrefix)
			record := fixtureAuthorization(uuid.NewString(), f.now)
			record.BindingHash = secret.Hash(binding)
			in := ScopedDecisionInput{DecisionInput: DecisionInput{RequestID: record.ID, Binding: binding, ExpectedUserID: p.UserID, Decision: "approve", Principal: p}, CatalogRevision: catalog.CatalogRevision, Scopes: []scopepolicy.ScopeID{"task:write", "task:read"}}
			if mode == "denied" {
				in.Decision = "deny"
				in.CatalogRevision = ""
				in.Scopes = nil
			}
			fresh := f.now.Add(time.Second)
			if mode == "expired" {
				fresh = record.ExpiresAt
			}
			if mode == "wrong binding" {
				record.BindingHash = secret.Hash(secret.Random(core.BindingPrefix))
			}
			if mode == "terminal" {
				record.Status = "denied"
			}
			s.operations.validBinding = core.ValidAuthorizationBinding
			s.operations.validDecision = core.ValidAuthorizationDecision
			f.authorization.read = func(id string, locked bool) (store.OAuthAuthorization, error) {
				f.equal(id, in.RequestID)
				f.equal(locked, true)
				return record, nil
			}
			f.authorization.fresh = func(now time.Time) (time.Time, error) { return fresh, nil }
			locks := 0
			f.identity.lock = func(actual model.Principal, now time.Time) error {
				f.equal(actual, p)
				locks++
				if locks == 2 && mode == "session expired" {
					return model.ErrNotFound
				}
				return nil
			}
			failure := errors.New("authorization update failed")
			f.authorization.update = func(a store.OAuthAuthorization) error {
				if a.ID != record.ID || a.UserID != p.UserID || a.Scope != core.Scope {
					t.Fatalf("wrong decided record: %+v", a)
				}
				if mode == "denied" {
					if a.Status != "denied" || a.ApprovedScopes != nil {
						t.Fatalf("denial: %+v", a)
					}
				} else {
					f.equal(a.ApprovedScopes, []scopepolicy.ScopeID{"task:read", "task:write"})
					if a.Status != "approved" || len(a.CodeHash) == 0 {
						t.Fatal("missing code")
					}
				}
				if mode == "update failure" {
					return failure
				}
				return nil
			}
			var callbackErr, errorOut error
			outcome := store.TransactionCommitted
			switch mode {
			case "expired", "wrong binding", "terminal":
				callbackErr = core.ErrInvalidAuthorization
				errorOut = callbackErr
				outcome = store.TransactionNotCommitted
			case "session expired":
				callbackErr = model.Unauthenticated(nil)
				errorOut = callbackErr
				outcome = store.TransactionNotCommitted
			case "update failure":
				callbackErr = failure
				errorOut = failure
				outcome = store.TransactionNotCommitted
			case "unknown":
				outcome = store.TransactionUnknown
			}
			f.plan("authorization", true, callbackErr, outcome, errorOut)
			result, err := s.DecideV2(f.ctx, in)
			if mode == "approved" || mode == "denied" {
				if err != nil || !strings.HasPrefix(result.RedirectURI, "https://client.example/cb?") {
					t.Fatalf("decision %v %v", result, err)
				}
			} else if err == nil || result.RedirectURI != "" {
				t.Fatalf("failed decision exposed result: %+v %v", result, err)
			}
			if mode == "unknown" && !errors.Is(err, core.ErrAuthorizationUnknown) {
				t.Fatal(err)
			}
		})
	}
}
