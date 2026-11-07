package postgres

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Snapshot) Credential(ctx context.Context, principal model.Principal) (ThreadCredential, error) {
	return pg.ThreadCredential(ctx, s.tx, principal, "")
}
