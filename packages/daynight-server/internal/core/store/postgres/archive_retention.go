package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

// WriteArchiveRetention fences graph and terminal-state changes before acquiring
// Session locks. Task writes take the same Project lock first, in exclusive mode.
func (s *Store) WriteArchiveRetention(ctx context.Context, project string, operation func(store.ArchiveRetentionDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin archive retention", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, project).Scan(&id); err != nil {
			return pg.QueryError("lock archive retention project", err)
		}
		return operation(session.NewArchiveRetention(tx, project))
	})
	return teamCompletion("write archive retention", err)
}
