package postgres

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) AssignPullRequestReviewer(ctx context.Context, activeWindow time.Duration) (bool, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, pg.QueryError("begin reviewer allocation", err)
	}
	var assigned bool
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var assignErr error
		assigned, assignErr = github.AssignPullRequestReviewer(ctx, tx, activeWindow)
		return assignErr
	})
	if err != nil {
		_, err = teamCompletion("assign pull request reviewer", err)
		return false, err
	}
	return assigned, nil
}
