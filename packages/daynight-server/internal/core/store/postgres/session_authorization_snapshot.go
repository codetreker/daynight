package postgres

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
)

func (s *Snapshot) SessionPATPolicy(ctx context.Context, p model.Principal, now time.Time) (model.PersonalAccessToken, error) {
	dao := identity.NewScope(s.tx, oauth.NewDAO(s.tx)).IdentityDAO().(interface {
		ReadPATScope(context.Context, string, string, time.Time) (model.PersonalAccessToken, error)
	})
	return dao.ReadPATScope(ctx, p.UserID, p.CredentialID, now)
}

func (s *Snapshot) SessionOAuthPolicy(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	return oauth.NewDAO(s.tx).ReadScopedAccess(ctx, p, bindings, now)
}

var _ store.ScopedSessionSnapshot = (*Snapshot)(nil)
