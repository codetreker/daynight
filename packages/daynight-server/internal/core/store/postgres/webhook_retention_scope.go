package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	dbwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook retention", err)
	}
	err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error { return fn(dbwebhook.New(tx)) })
	return teamCompletion("write webhook retention", err)
}

// ObserveWebhookRetention performs a fresh read after an unknown commit. It
// makes no inference about which transaction produced the current state.
func (s *Store) ObserveWebhookRetention(ctx context.Context, kind, id string) error {
	var observation []byte
	var err error
	if id == "" {
		kind = ""
	}
	switch kind {
	case "delivery":
		err = s.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT json_build_object('purging',purging_at IS NOT NULL,'payloadRemoved',payload_removed_at IS NOT NULL,'matches',(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id),'attempts',(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id)) FROM webhook_deliveries d WHERE id=$1),'null'::json)`, id).Scan(&observation)
	case "event":
		err = s.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT json_build_object('factRemoved',fact_removed_at IS NOT NULL,'deliveries',(SELECT count(*) FROM webhook_deliveries WHERE event_id=e.id)) FROM webhook_events e WHERE id=$1),'null'::json)`, id).Scan(&observation)
	default:
		err = s.Pool.QueryRow(ctx, `SELECT 'null'::json`).Scan(&observation)
	}
	if err != nil {
		return pg.QueryError("observe webhook retention", err)
	}
	return nil
}

var _ store.WebhookRetentionTransactions = (*Store)(nil)
