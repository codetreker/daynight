package postgres

import (
	"context"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/jackc/pgx/v5"
)

// WriteProjectCreation locks the creator before the callback selects and locks
// the Team. A Project row cannot be locked until it exists.
func (s *Store) WriteProjectCreation(ctx context.Context, userID string, operation func(ProjectCreationDAO) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, pg.QueryError("begin project creation", err)
	}
	err = writeProjectCreationTx(ctx, tx, userID, operation)
	return teamCompletion("create project", err)
}

func writeProjectCreationTx(ctx context.Context, tx pgx.Tx, userID string, operation func(ProjectCreationDAO) error) error {
	return transact(ctx, tx, func(tx pgx.Tx) error {
		var user string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR KEY SHARE`, userID).Scan(&user); err != nil {
			return pg.AuthQueryError("read project creator", err)
		}
		return operation(project.NewCreation(tx, userID))
	})
}
