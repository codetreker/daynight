package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ScopedGrantManagement is an opt-in account management path for deployments
// that have completed scope migration. It shares the lifecycle transaction writer.
type ScopedGrantManagement struct {
	lifecycle *GrantLifecycle
	catalog   scopepolicy.CatalogSnapshot
}

func NewScopedGrantManagement(lifecycle *GrantLifecycle, catalog scopepolicy.CatalogSnapshot) (*ScopedGrantManagement, error) {
	if lifecycle == nil || lifecycle.writer == nil {
		return nil, errors.New("OAuth lifecycle is required")
	}
	var ids []scopepolicy.ScopeID
	for _, group := range catalog.Groups {
		ids = append(ids, group.ScopeIDs...)
	}
	canonical, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, ids)
	if err != nil || !reflect.DeepEqual(canonical, catalog) {
		return nil, errors.New("invalid MCP scope catalog")
	}
	return &ScopedGrantManagement{lifecycle: lifecycle, catalog: catalog.Clone()}, nil
}

func (s *ScopedGrantManagement) ListSessionGrants(ctx context.Context, principal model.Principal) ([]store.OAuthGrant, time.Time, error) {
	if !validOwnerSession(principal) {
		return nil, time.Time{}, model.Unauthenticated(nil)
	}
	var grants []store.OAuthGrant
	var observed time.Time
	c, err := s.lifecycle.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		if err := s.lifecycle.checkOwnerSession(ctx, d, principal); err != nil {
			return err
		}
		scoped, ok := d.(store.OAuthScopeDAO)
		if !ok {
			return errors.New("OAuth lifecycle lacks scoped grant capability")
		}
		var err error
		grants, err = scoped.ScopedOwnerGrants(ctx, principal.UserID)
		if err != nil {
			return err
		}
		observed, err = s.lifecycle.checkOwnerSessionAt(ctx, d, principal)
		return err
	})
	if err := lifecycleCompletion(c, err); err != nil {
		return nil, time.Time{}, err
	}
	return grants, observed, nil
}

func (s *ScopedGrantManagement) UpdateSessionGrantScope(ctx context.Context, p model.Principal, expectedUser, grantID string, expected int64, revision string, scopes []scopepolicy.ScopeID) (store.OAuthGrant, time.Time, error) {
	if !validOwnerSession(p) {
		return store.OAuthGrant{}, time.Time{}, model.Unauthenticated(nil)
	}
	if !validID(expectedUser) || !validID(grantID) || expected < 1 {
		return store.OAuthGrant{}, time.Time{}, invalidInput()
	}
	if expectedUser != p.UserID {
		return store.OAuthGrant{}, time.Time{}, &model.Fault{Code: "identity_mismatch", Message: "The current account differs from the expected account."}
	}
	if revision != s.catalog.CatalogRevision {
		return store.OAuthGrant{}, time.Time{}, &model.Fault{Code: "version_conflict", Message: "Scope catalog changed. Review the current options."}
	}
	var result store.OAuthGrant
	var now time.Time
	c, err := s.lifecycle.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		scoped, ok := d.(store.OAuthScopeDAO)
		if !ok {
			return errors.New("OAuth lifecycle lacks scoped grant capability")
		}
		now = s.lifecycle.clock()
		var err error
		result, err = updateSessionGrantScope(ctx, d, scoped, p, expectedUser, grantID, expected, scopes, now, &s.catalog)
		if err != nil {
			return err
		}
		var client ValidatedClient
		if json.Unmarshal(result.ClientSnapshot, &client) != nil || client.ClientID != result.ClientID || result.ScopePolicy == nil {
			return fmt.Errorf("invalid grant projection")
		}
		return nil
	})
	if err := lifecycleCompletion(c, err); err != nil {
		return store.OAuthGrant{}, time.Time{}, err
	}
	return result, now, nil
}
