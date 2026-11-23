package oauth

import (
	"context"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// AuthenticateAPIAccess returns the persisted application access identity and
// effective expiry for the configured API audience after confirmed commit.
func (a *Authenticator) AuthenticateAPIAccess(ctx context.Context, token string) (store.OAuthAccessIdentity, error) {
	if !core.ValidAPIOrigin(a.apiOrigin) {
		return store.OAuthAccessIdentity{}, core.ErrInvalidAuthorization
	}
	return a.AuthenticateAccess(ctx, token, a.apiOrigin+"/api/v1")
}
