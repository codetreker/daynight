package oauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// PruneClients processes at most budget candidates in transactions of at most
// 100. It returns the number deleted and does not treat failures as capacity.
// The caller owns scheduling and retries after a failure.
func PruneClients(ctx context.Context, writer store.OAuthClientWriter, budget int, now time.Time) (int, error) {
	if budget < 0 {
		return 0, fmt.Errorf("invalid OAuth client cleanup budget")
	}
	budget = min(budget, 2000)
	deleted := 0
	for budget > 0 {
		batch := min(budget, 100)
		examined := 0
		batchDeleted := 0
		completion, err := writer.WriteOAuthClients(ctx, func(scope store.OAuthClientScope) error {
			clients := scope.OAuthClientDAO()
			if err := clients.LockClientCapacity(ctx); err != nil {
				return err
			}
			ids, err := clients.ExpiredClients(ctx, now, batch)
			if err != nil {
				return err
			}
			examined = len(ids)
			for _, id := range ids {
				c, err := clients.Client(ctx, id, true)
				if errors.Is(err, model.ErrNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				fresh, err := clients.FreshTime(ctx, now)
				if err != nil {
					return err
				}
				if c.ExpiresAt.After(fresh) || c.LastUsedAt.Add(7*24*time.Hour).After(fresh) {
					continue
				}
				active, err := scope.CredentialFamilyDAO().ActiveClientReferences(ctx, id, fresh)
				if err != nil {
					return err
				}
				if active {
					continue
				}
				if err := clients.DeleteClient(ctx, id); err != nil {
					return err
				}
				batchDeleted++
			}
			return nil
		})
		if err != nil {
			return deleted, err
		}
		if completion.Outcome != store.TransactionCommitted {
			return deleted, fmt.Errorf("OAuth cleanup transaction outcome: %s", completion.Outcome)
		}
		deleted += batchDeleted
		budget -= examined
		if examined < batch {
			break
		}
	}
	return deleted, nil
}
