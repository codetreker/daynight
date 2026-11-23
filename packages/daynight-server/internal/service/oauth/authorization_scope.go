package oauth

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type AuthorizationViewV2 struct {
	AuthorizationView
	CatalogRevision *string `json:"catalogRevision,omitempty"`
}

type ScopedDecisionInput struct {
	DecisionInput
	CatalogRevision string
	Scopes          []scopepolicy.ScopeID
}

// NewAuthorizationsWithScopes prepares explicit browser approval and scoped
// redemption without changing production assembly before coordinated activation.
func NewAuthorizationsWithScopes(writer store.AuthorizationWriter, clients *Clients, admission core.PublicAdmission, issuer string, catalog scopepolicy.CatalogSnapshot) (*Authorizations, error) {
	s, err := NewAuthorizations(writer, clients, admission, issuer)
	if err != nil {
		return nil, err
	}
	snapshot := catalog.Clone()
	s.catalog = &snapshot
	s.operations.decide = func(a *store.OAuthAuthorization, binding, decision, user, issuer string, now time.Time) (string, error) {
		if decision == "approve" {
			return "", core.ErrInvalidAuthorization
		}
		return core.DecideAuthorizationScoped(a, binding, decision, user, issuer, nil, now)
	}
	s.operations.issueFamily = core.IssueScopedFamily
	return s, nil
}

func (s *Authorizations) ScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	if s.catalog == nil {
		return scopepolicy.CatalogSnapshot{}, false
	}
	return s.catalog.Clone(), true
}

func (s *Authorizations) InspectV2(ctx context.Context, id, binding string, principal model.Principal) (AuthorizationViewV2, error) {
	if s.catalog == nil {
		return AuthorizationViewV2{}, errors.New("OAuth scope catalog is unavailable")
	}
	view, err := s.Inspect(ctx, id, binding, principal)
	if err != nil {
		return AuthorizationViewV2{}, err
	}
	result := AuthorizationViewV2{AuthorizationView: view}
	if view.Status == "pending" {
		revision := s.catalog.CatalogRevision
		result.CatalogRevision = &revision
	}
	return result, nil
}

func (s *Authorizations) DecideV2(ctx context.Context, in ScopedDecisionInput) (DecisionResult, error) {
	if s.catalog == nil {
		return DecisionResult{}, errors.New("OAuth scope catalog is unavailable")
	}
	if !validSession(in.Principal) {
		return DecisionResult{}, model.Unauthenticated(nil)
	}
	if !canonicalID(in.RequestID) || in.Principal.UserID != in.ExpectedUserID || !core.ValidAuthorizationBinding(in.Binding) || !core.ValidAuthorizationDecision(in.Decision) {
		return DecisionResult{}, core.ErrInvalidAuthorization
	}
	if in.Decision == "approve" {
		if in.CatalogRevision != s.catalog.CatalogRevision {
			return DecisionResult{}, &model.Fault{Code: "version_conflict", Message: "Scope catalog changed. Review the current options."}
		}
		var err error
		in.Scopes, err = s.catalog.ValidateSelection(scopepolicy.MCP, in.Scopes)
		if err != nil {
			return DecisionResult{}, &model.Fault{Code: "invalid_input", Message: "Invalid OAuth scopes."}
		}
	} else if in.CatalogRevision != "" || in.Scopes != nil {
		return DecisionResult{}, &model.Fault{Code: "invalid_input", Message: "A denied authorization cannot include scopes."}
	}
	return s.decide(ctx, in.DecisionInput, func(a *store.OAuthAuthorization, binding, decision, user, issuer string, now time.Time) (string, error) {
		return core.DecideAuthorizationScoped(a, binding, decision, user, issuer, in.Scopes, now)
	})
}
