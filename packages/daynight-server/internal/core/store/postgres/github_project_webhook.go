package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubProjectWebhookSecret(ctx context.Context, id string) (store.GitHubProjectWebhookSecret, error) {
	var out store.GitHubProjectWebhookSecret
	err := readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error {
		var e error
		out, e = github.ReadProjectWebhookSecret(ctx, tx, id)
		return e
	}, true)
	if err != nil {
		return store.GitHubProjectWebhookSecret{}, err
	}
	return out, nil
}
