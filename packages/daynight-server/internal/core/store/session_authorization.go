package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ScopedSessionAuthorizationScope exposes credential policy DAOs bound to the
// same transaction as the Session operation. The scope and DAOs cannot escape
// the SessionWriter callback.
type ScopedSessionAuthorizationScope interface {
	PATScopeDAO() PATScopeDAO
	PATManagementDAO() PATManagementDAO
	OAuthScopeDAO() OAuthScopeDAO
}

// ScopedSessionSnapshot reads current credential facts in the caller's
// repeatable-read snapshot. Implementations preserve the requested bindings.
type ScopedSessionSnapshot interface {
	SessionPATPolicy(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error)
	SessionOAuthPolicy(context.Context, model.Principal, []OAuthBinding, time.Time) (OAuthAccessIdentity, error)
}
