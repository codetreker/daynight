package postgres

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type webhookRecoverySnapshot struct{ tx pgx.Tx }

func (s *Store) OpenWebhookRecoverySnapshot(ctx context.Context) (store.WebhookRecoverySnapshot, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, pg.QueryError("begin webhook recovery snapshot", err)
	}
	return &webhookRecoverySnapshot{tx: tx}, nil
}
func (s *webhookRecoverySnapshot) RecoveryIdentity(ctx context.Context) (store.WebhookRecoveryIdentity, error) {
	var id store.WebhookRecoveryIdentity
	// Recovery DSNs can select writable schemas; none may shadow the system
	// functions, catalog, type, or equality operator used for this identity.
	err := s.tx.QueryRow(ctx, `SELECT (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text, oid FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`).Scan(&id.ClusterID, &id.DatabaseOID)
	if err != nil {
		return id, pg.QueryError("read webhook recovery database identity", err)
	}
	if id.ClusterID == "" || id.DatabaseOID == 0 {
		return id, fmt.Errorf("invalid webhook recovery database identity")
	}
	return id, nil
}
func (s *webhookRecoverySnapshot) WebhookMasterKeyIDs(ctx context.Context) ([]string, error) {
	rows, err := s.tx.Query(ctx, `SELECT master_key_id FROM (SELECT destination_master_key_id AS master_key_id FROM webhook_endpoints WHERE destination_master_key_id IS NOT NULL UNION SELECT master_key_id FROM webhook_signing_keys UNION SELECT destination_master_key_id FROM webhook_deliveries) AS referenced ORDER BY master_key_id`)
	if err != nil {
		return nil, pg.QueryError("read webhook recovery references", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, pg.QueryError("scan webhook recovery references", err)
		}
		if id == "" {
			return nil, fmt.Errorf("invalid webhook master key reference")
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook recovery references", err)
	}
	return ids, nil
}
func (s *webhookRecoverySnapshot) WebhookCiphertexts(ctx context.Context, master string, after *store.WebhookCiphertext, limit int) ([]store.WebhookCiphertext, error) {
	return scanWebhookCiphertexts(ctx, s.tx, master, after, limit)
}
func (s *webhookRecoverySnapshot) WebhookCiphertextByID(ctx context.Context, kind, id string) (*store.WebhookCiphertext, error) {
	return readWebhookCiphertext(ctx, s.tx, kind, id)
}
func (s *webhookRecoverySnapshot) Close(ctx context.Context) error { return s.tx.Rollback(ctx) }
