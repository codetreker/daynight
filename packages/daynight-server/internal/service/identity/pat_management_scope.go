package identity

import (
	"context"
	"errors"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func scopedPAT(scope store.IdentityScope) (store.IdentityDAO, store.PATManagementDAO, store.PATScopeDAO, error) {
	dao, management, err := patManagement(scope)
	if err != nil {
		return nil, nil, nil, err
	}
	scoped, ok := dao.(store.PATScopeDAO)
	if !ok {
		return nil, nil, nil, errors.New("identity scope lacks PAT scope capability")
	}
	return dao, management, scoped, nil
}

func (s *Identity) ListScopedPATs(ctx context.Context, p model.Principal) ([]model.PersonalAccessToken, error) {
	var result []model.PersonalAccessToken
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, scoped, err := scopedPAT(scope)
		if err != nil {
			return err
		}
		result, err = core.NewIdentity(s.callbackURL).ListScopedPATs(ctx, dao, scoped, management, p, s.now().UTC())
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Identity) CreateScopedPAT(ctx context.Context, p model.Principal, expected string, input core.CreatePAT, description *string, revision string, selected []scopepolicy.ScopeID) (core.MintedPAT, error) {
	if err := core.ValidatePATOwner(p, expected); err != nil {
		return core.MintedPAT{}, err
	}
	if s.deviceCatalog == nil {
		return core.MintedPAT{}, errors.New("PAT scope catalog is unavailable")
	}
	if revision != s.deviceCatalog.CatalogRevision {
		return core.MintedPAT{}, &model.Fault{Code: "version_conflict", Message: "Scope catalog changed. Review the current options."}
	}
	selected, err := s.deviceCatalog.ValidateSelection(scopepolicy.PAT, selected)
	if err != nil {
		return core.MintedPAT{}, &model.Fault{Code: "invalid_input", Message: "Invalid token scopes."}
	}
	var result core.MintedPAT
	err = s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, _, err := scopedPAT(scope)
		if err != nil {
			return err
		}
		result, err = core.NewIdentity(s.callbackURL).CreateScopedPAT(ctx, dao, management, p, expected, input, description, selected, s.now().UTC())
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}

func (s *Identity) UpdateScopedPAT(ctx context.Context, p model.Principal, id, expected string, version int64, revision string, selected []scopepolicy.ScopeID) (model.PersonalAccessToken, error) {
	if err := core.ValidatePATOwner(p, expected); err != nil {
		return model.PersonalAccessToken{}, err
	}
	if s.deviceCatalog == nil {
		return model.PersonalAccessToken{}, errors.New("PAT scope catalog is unavailable")
	}
	if revision != s.deviceCatalog.CatalogRevision {
		return model.PersonalAccessToken{}, &model.Fault{Code: "version_conflict", Message: "Scope catalog changed. Review the current options."}
	}
	var result model.PersonalAccessToken
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, scoped, err := scopedPAT(scope)
		if err != nil {
			return err
		}
		result, err = core.NewIdentity(s.callbackURL).UpdatePATScopeWithCatalog(ctx, dao, scoped, management, p, id, expected, version, selected, s.deviceCatalog.Clone(), s.now().UTC())
		return err
	})
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	return result, nil
}
