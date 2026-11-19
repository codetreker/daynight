package bot

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// Barrier borrows the caller's transaction. Bot deletion updates the row under
// its exclusive lock, so the shared lock orders this transaction against it.
type Barrier struct{ tx pgx.Tx }

func NewBarrier(tx pgx.Tx) *Barrier { return &Barrier{tx: tx} }

var _ store.BotBarrierDAO = (*Barrier)(nil)

func (b *Barrier) Bot(ctx context.Context, id string) (model.Bot, error) {
	var locked string
	if err := b.tx.QueryRow(ctx, `SELECT id::text FROM bots WHERE id=$1 FOR SHARE`, id).Scan(&locked); err != nil {
		return model.Bot{}, pg.QueryError("lock Bot barrier", err)
	}
	// A lock wait keeps the statement's earlier snapshot. Read the row in a new
	// statement so a deletion committed during the wait is observed.
	return NewReader(b.tx).Bot(ctx, id)
}
