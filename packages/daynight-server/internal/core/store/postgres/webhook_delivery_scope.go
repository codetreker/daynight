package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	dbwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteWebhookDelivery(ctx context.Context, operation func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook delivery", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(dbwebhook.New(tx)) })
	return teamCompletion("write webhook delivery", err)
}

var _ store.WebhookDeliveryTransactions = (*Store)(nil)
