package identity

import (
	"context"
	"errors"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func patManagement(scope store.IdentityScope) (store.IdentityDAO, store.PATManagementDAO, error) {
	dao := scope.IdentityDAO()
	management, ok := dao.(store.PATManagementDAO)
	if !ok {
		return nil, nil, errors.New("identity scope lacks PAT management capability")
	}
	return dao, management, nil
}

func (s *Identity) ListPATsV2(ctx context.Context, p model.Principal) ([]model.PersonalAccessToken, error) {
	var result []model.PersonalAccessToken
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, err := patManagement(scope)
		if err != nil {
			return err
		}
		result, err = core.NewIdentity(s.callbackURL).ListPATsV2(ctx, dao, management, p, s.now().UTC())
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Identity) CreatePATV2(ctx context.Context, p model.Principal, expectedUserID string, input core.CreatePAT, description *string) (core.MintedPAT, error) {
	var result core.MintedPAT
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, err := patManagement(scope)
		if err != nil {
			return err
		}
		result, err = core.NewIdentity(s.callbackURL).CreatePATV2(ctx, dao, management, p, expectedUserID, input, description, s.now().UTC())
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}

func (s *Identity) UpdatePATDescription(ctx context.Context, p model.Principal, id, expectedUserID string, expected, description *string) (string, *string, error) {
	var resultID string
	var result *string
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		dao, management, err := patManagement(scope)
		if err != nil {
			return err
		}
		resultID, result, err = core.NewIdentity(s.callbackURL).UpdatePATDescription(ctx, dao, management, p, id, expectedUserID, expected, description, s.now().UTC())
		return err
	})
	if err != nil {
		return "", nil, err
	}
	return resultID, result, nil
}
