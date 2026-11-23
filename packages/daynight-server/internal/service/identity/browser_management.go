package identity

import (
	"context"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Identity) ListBrowserSessions(ctx context.Context, p model.Principal, cursor string, limit int) (core.BrowserSessionPage, error) {
	var result core.BrowserSessionPage
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = core.NewIdentity(s.callbackURL).ListBrowserSessions(ctx, scope.IdentityDAO(), p, cursor, limit)
		return err
	})
	if err != nil {
		return core.BrowserSessionPage{}, err
	}
	return result, nil
}
func (s *Identity) GetBrowserSession(ctx context.Context, p model.Principal, id string) (model.Session, error) {
	var result model.Session
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = core.NewIdentity(s.callbackURL).GetBrowserSession(ctx, scope.IdentityDAO(), p, id)
		return err
	})
	if err != nil {
		return model.Session{}, err
	}
	return result, nil
}
func (s *Identity) RevokeBrowserSession(ctx context.Context, p model.Principal, id, expectedUserID, expectedSessionID string) error {
	return s.strict(ctx, func(scope store.IdentityScope) error {
		return core.NewIdentity(s.callbackURL).RevokeBrowserSession(ctx, scope.IdentityDAO(), p, id, expectedUserID, expectedSessionID)
	})
}
