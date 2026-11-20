package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ScopedSessionSnapshot reads current credential facts in the caller's
// repeatable-read snapshot. Implementations preserve the requested bindings.
type ScopedSessionSnapshot interface {
	SessionPATPolicy(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error)
	SessionOAuthPolicy(context.Context, model.Principal, []OAuthBinding, time.Time) (OAuthAccessIdentity, error)
}
