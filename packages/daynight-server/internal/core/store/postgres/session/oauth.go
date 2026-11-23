package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
)

func (tx *DAO) LockOAuthCredential(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	return pgoauth.NewDAO(tx.tx).LockAccess(ctx, p, bindings, now)
}

func (tx *DAO) ReadOAuthCredential(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	return pgoauth.NewDAO(tx.tx).ReadAccess(ctx, p, bindings, now)
}
