package oauth

import (
	"errors"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestScopedAuthorizationDecisionPreservesProtocolAndSelection(t *testing.T) {
	now := time.Now().UTC()
	for _, decision := range []string{"approve", "deny"} {
		t.Run(decision, func(t *testing.T) {
			binding := secret.Random(BindingPrefix)
			a := NewAuthorization(AuthorizationRequest{ID: uuid.NewString(), Binding: binding, RedirectURI: "https://client.example/cb", Scope: Scope, State: "state", StatePresent: true}, now)
			var selected []scopepolicy.ScopeID
			if decision == "approve" {
				selected = []scopepolicy.ScopeID{"task:write", "task:read"}
			}
			redirect, err := DecideAuthorizationScoped(&a, binding, decision, uuid.NewString(), "https://server.example", selected, now)
			if err != nil {
				t.Fatal(err)
			}
			u, err := url.Parse(redirect)
			if err != nil {
				t.Fatal(err)
			}
			if u.Query().Get("state") != "state" || u.Query().Get("iss") != "https://server.example" || a.Scope != Scope || a.State != "" {
				t.Fatalf("protocol changed: %+v %s", a, redirect)
			}
			if decision == "approve" {
				if !secret.Valid(u.Query().Get("code"), CodePrefix) || !reflect.DeepEqual(a.ApprovedScopes, []scopepolicy.ScopeID{"task:read", "task:write"}) {
					t.Fatalf("approval: %+v", a)
				}
				selected[0] = "task:delete"
				if a.ApprovedScopes[1] != "task:write" {
					t.Fatal("selection aliased")
				}
			} else if a.ApprovedScopes != nil || u.Query().Get("error") != "access_denied" {
				t.Fatalf("denial: %+v", a)
			}
			before := a
			if _, err = DecideAuthorizationScoped(&a, binding, decision, a.UserID, "https://server.example", a.ApprovedScopes, now); !errors.Is(err, ErrInvalidAuthorization) || !reflect.DeepEqual(a, before) {
				t.Fatalf("terminal decision changed: %v", err)
			}
		})
	}
}

func TestScopedAuthorizationRejectsInvalidSelectionWithoutMutation(t *testing.T) {
	for _, selected := range [][]scopepolicy.ScopeID{nil, {}, {"task:read", "task:read"}, {"worker:claim"}, {"unknown"}} {
		now := time.Now()
		binding := secret.Random(BindingPrefix)
		a := NewAuthorization(AuthorizationRequest{Binding: binding}, now)
		before := a
		if _, err := DecideAuthorizationScoped(&a, binding, "approve", uuid.NewString(), "https://server.example", selected, now); err == nil || !reflect.DeepEqual(a, before) {
			t.Fatalf("accepted %v: %v", selected, err)
		}
	}
}

func TestIssueScopedFamilyRequiresCanonicalApproval(t *testing.T) {
	for _, selected := range [][]scopepolicy.ScopeID{{"task:read", "task:write"}, nil, {}, {"task:write", "task:read"}, {"unknown"}} {
		t.Run(stringIDs(selected), func(t *testing.T) {
			calls := 0
			valid := reflect.DeepEqual(selected, []scopepolicy.ScopeID{"task:read", "task:write"})
			if valid {
				calls = 1
			}
			dao := newIssuanceDAO(t, t.Context(), calls)
			in := input()
			in.ApprovedScopes = selected
			got, err := IssueScopedFamily(t.Context(), dao, in, time.Now())
			if !valid {
				if err == nil || got.AccessToken != "" || got.RefreshToken != "" {
					t.Fatal("invalid approval issued credentials")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Grant.Scope != Scope || got.Grant.ScopePolicy == nil || got.Grant.ScopePolicy.Version() != 1 || !reflect.DeepEqual(got.Grant.ScopePolicy.Scopes(), selected) || !reflect.DeepEqual(got.Grant, dao.issue.Grant) {
				t.Fatalf("grant policy not inserted: %+v", got.Grant)
			}
		})
	}
}
func stringIDs(ids []scopepolicy.ScopeID) string {
	if len(ids) == 0 {
		return "empty"
	}
	return string(ids[0])
}
