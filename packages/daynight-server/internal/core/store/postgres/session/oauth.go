package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pgoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
)

func (tx *DAO) LockOAuthCredential(ctx context.Context, p model.Principal, resource, scope string, now time.Time) error {
	return pgoauth.NewDAO(tx.tx).LockAccess(ctx, p, resource, scope, now)
}
