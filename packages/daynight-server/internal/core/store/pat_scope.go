package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// PATScopeDAO exposes transaction-bound reads and conditional scope updates.
// Scoped reads reject missing or malformed persisted policy; legacy callers use
// IdentityDAO until the scoped credential cutover is complete.
type PATScopeDAO interface {
	PATByHash(context.Context, []byte, time.Time) (model.PersonalAccessToken, error)
	ListPATScopes(context.Context, string) ([]model.PersonalAccessToken, error)
	ReadLockedPATScope(context.Context, string, string) (model.PersonalAccessToken, error)
	LockPATScope(context.Context, string, string) (model.PersonalAccessToken, error)
	ComparePATScope(context.Context, string, string, int64, []scopepolicy.ScopeID, time.Time) (model.PersonalAccessToken, error)
}
