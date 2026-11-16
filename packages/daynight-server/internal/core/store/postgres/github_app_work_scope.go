package postgres

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteGitHubAppWork(ctx context.Context, projectID string, expected *store.GitHubAppWorkIdentity, operation func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github App work", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		dao, err := github.NewAppWorkWriter(ctx, tx, projectID, expected)
		if err != nil {
			return err
		}
		return operation(dao)
	})
	return teamCompletion("write github App work", err)
}

func (s *Store) DueGitHubAppProjects(ctx context.Context, now time.Time, limit int) ([]string, error) {
	return github.NewAppWorkReader(s.Pool).DueGitHubAppProjects(ctx, now, limit)
}
