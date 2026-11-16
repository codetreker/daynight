package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubAppImpact(ctx context.Context, operation func(store.GitHubAppImpactDAO) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(github.NewAppImpactReader(tx)) }, true)
}
