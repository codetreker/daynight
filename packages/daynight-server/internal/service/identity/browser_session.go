package identity

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Identity) AuthenticateBrowserActivity(ctx context.Context, value, expectedUserID string) (model.Principal, error) {
	var principal model.Principal
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		var err error
		principal, err = s.ops.authenticateBrowserActivity(ctx, scope.IdentityDAO(), value, expectedUserID)
		return err
	})
	if err != nil {
		return model.Principal{}, err
	}
	return principal, nil
}

func (s *PreviewSSO) Renew(ctx context.Context, value string, principal model.Principal) error {
	return s.run(ctx, func(dao store.PreviewSSODAO) error {
		return s.ops.Renew(ctx, dao, value, principal)
	})
}
