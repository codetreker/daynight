package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// OAuthScopeDAO exposes current grant policy without copying it to tokens.
// Scoped MCP reads reject absent or malformed policy; fixed profiles retain nil.
// Locked access reads hold the grant before the access row until transaction end.
type OAuthScopeDAO interface {
	ScopedAccess(context.Context, []byte, []OAuthBinding, time.Time) (OAuthAccessIdentity, error)
	LockScopedAccess(context.Context, model.Principal, []OAuthBinding, time.Time) (OAuthAccessIdentity, error)
	ScopedOwnerGrants(context.Context, string) ([]OAuthGrant, error)
	LockGrantScope(context.Context, string, string) (OAuthGrant, error)
	CompareGrantScope(context.Context, string, string, int64, []scopepolicy.ScopeID, time.Time) (OAuthGrant, error)
}
