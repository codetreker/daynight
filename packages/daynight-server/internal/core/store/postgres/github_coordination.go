package postgres

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) DueGitHubProjects(ctx context.Context, appID int64, now time.Time, limit int) ([]string, error) {
	return github.NewWorkReader(s.Pool).DueGitHubProjects(ctx, appID, now, limit)
}

func (s *Store) WriteGitHubSignals(ctx context.Context, operation func(store.GitHubSignalWriter) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github signal", err)
	}
	err = transactSignal(ctx, tx, func(tx pgx.Tx) error { return operation(github.NewSignalWriter(tx)) })
	return teamCompletion("write github signal", err)
}
