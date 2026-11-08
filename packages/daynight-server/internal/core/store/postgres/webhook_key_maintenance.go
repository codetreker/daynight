package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.WebhookKeyMaintenance = (*Store)(nil)

// WebhookCiphertexts reads indexed candidates for one old master. An orphaned
// signing key is reported as corruption rather than hidden by an inner join.
func (s *Store) WebhookCiphertexts(ctx context.Context, master string, after *store.WebhookCiphertext, limit int) ([]store.WebhookCiphertext, error) {
	return scanWebhookCiphertexts(ctx, s.Pool, master, after, limit)
}

type webhookRecoveryQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func scanWebhookCiphertexts(ctx context.Context, db webhookRecoveryQueryer, master string, after *store.WebhookCiphertext, limit int) ([]store.WebhookCiphertext, error) {
	if master == "" || limit < 1 || limit > 500 {
		return nil, fmt.Errorf("invalid webhook ciphertext scan")
	}
	queries := []string{
		`SELECT 'endpoint-current', e.id::text, e.id::text, e.owner_kind, e.owner_id::text, e.destination_revision::text, e.destination_envelope_version, e.destination_master_key_id, e.destination_nonce, e.destination_ciphertext FROM webhook_endpoints e WHERE e.destination_master_key_id=$1 AND ($3::uuid IS NULL OR e.id > $3::uuid) ORDER BY e.id LIMIT $2`,
		`SELECT 'signing-key', k.id::text, k.endpoint_id::text, e.owner_kind, e.owner_id::text, k.id::text, k.envelope_version, k.master_key_id, k.nonce, k.ciphertext FROM webhook_signing_keys k LEFT JOIN webhook_endpoints e ON e.id=k.endpoint_id WHERE k.master_key_id=$1 AND ($3::uuid IS NULL OR (k.endpoint_id,k.id) > ($3::uuid,$4::uuid)) ORDER BY k.endpoint_id,k.id LIMIT $2`,
		`SELECT 'delivery-destination', d.id::text, d.endpoint_id::text, d.owner_kind, d.owner_id::text, d.id::text, d.destination_envelope_version, d.destination_master_key_id, d.destination_nonce, d.destination_ciphertext FROM webhook_deliveries d WHERE d.destination_master_key_id=$1 AND ($3::uuid IS NULL OR d.id > $3::uuid) ORDER BY d.id LIMIT $2`,
	}
	result := make([]store.WebhookCiphertext, 0, limit)
	kinds := []string{"endpoint-current", "signing-key", "delivery-destination"}
	start := 0
	if after != nil {
		start = -1
		for i, kind := range kinds {
			if after.Kind == kind {
				start = i
				break
			}
		}
		if start < 0 || after.MasterKeyID != master {
			return nil, fmt.Errorf("invalid webhook ciphertext cursor")
		}
	}
	for i := start; i < len(queries); i++ {
		query := queries[i]
		var cursorID, cursorEndpoint any
		if after != nil && after.Kind == kinds[i] {
			cursorID, cursorEndpoint = after.ID, after.EndpointID
		}
		args := []any{master, limit - len(result), cursorID}
		if kinds[i] == "signing-key" {
			args[2] = cursorEndpoint
			args = append(args, cursorID)
		}
		remaining := limit - len(result)
		if remaining == 0 {
			break
		}
		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			return nil, pg.QueryError("scan webhook ciphertexts", err)
		}
		for rows.Next() {
			var c store.WebhookCiphertext
			var kind, owner *string
			if err = rows.Scan(&c.Kind, &c.ID, &c.EndpointID, &kind, &owner, &c.RecordID, &c.Version, &c.MasterKeyID, &c.Nonce, &c.Ciphertext); err != nil {
				break
			}
			if kind == nil || owner == nil {
				err = fmt.Errorf("orphaned webhook signing key")
				break
			}
			c.OwnerKind, c.OwnerID = *kind, *owner
			result = append(result, c)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return nil, pg.QueryError("read webhook ciphertexts", err)
		}
	}
	return result, nil
}

func (s *Store) CompareAndSwapWebhookCiphertext(ctx context.Context, old, next store.WebhookCiphertext) (bool, error) {
	if old.Kind != next.Kind || old.ID != next.ID || old.EndpointID != next.EndpointID || old.OwnerKind != next.OwnerKind || old.OwnerID != next.OwnerID || old.RecordID != next.RecordID {
		return false, fmt.Errorf("webhook ciphertext identity changed")
	}
	var query string
	switch old.Kind {
	case "endpoint-current":
		query = `UPDATE webhook_endpoints SET destination_envelope_version=$1,destination_master_key_id=$2,destination_nonce=$3,destination_ciphertext=$4 WHERE id=$5 AND id=$6 AND owner_kind=$7 AND owner_id=$8 AND destination_revision::text=$9 AND destination_envelope_version=$10 AND destination_master_key_id=$11 AND destination_nonce=$12 AND destination_ciphertext=$13`
	case "signing-key":
		query = `UPDATE webhook_signing_keys k SET envelope_version=$1,master_key_id=$2,nonce=$3,ciphertext=$4 WHERE k.id=$5 AND k.endpoint_id=$6 AND k.id::text=$9 AND k.envelope_version=$10 AND k.master_key_id=$11 AND k.nonce=$12 AND k.ciphertext=$13 AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.id=k.endpoint_id AND e.owner_kind=$7 AND e.owner_id=$8)`
	case "delivery-destination":
		query = `UPDATE webhook_deliveries SET destination_envelope_version=$1,destination_master_key_id=$2,destination_nonce=$3,destination_ciphertext=$4 WHERE id=$5 AND endpoint_id=$6 AND owner_kind=$7 AND owner_id=$8 AND id::text=$9 AND destination_envelope_version=$10 AND destination_master_key_id=$11 AND destination_nonce=$12 AND destination_ciphertext=$13`
	default:
		return false, fmt.Errorf("unknown webhook ciphertext kind")
	}
	tag, err := s.Pool.Exec(ctx, query, next.Version, next.MasterKeyID, next.Nonce, next.Ciphertext, old.ID, old.EndpointID, old.OwnerKind, old.OwnerID, old.RecordID, old.Version, old.MasterKeyID, old.Nonce, old.Ciphertext)
	if err != nil {
		return false, pg.QueryError("replace webhook ciphertext", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) WebhookCiphertextByID(ctx context.Context, kind, id string) (*store.WebhookCiphertext, error) {
	return readWebhookCiphertext(ctx, s.Pool, kind, id)
}
func readWebhookCiphertext(ctx context.Context, db webhookRecoveryQueryer, kind, id string) (*store.WebhookCiphertext, error) {
	var query string
	switch kind {
	case "endpoint-current":
		query = `SELECT 'endpoint-current', e.id::text, e.id::text, e.owner_kind, e.owner_id::text, e.destination_revision::text, e.destination_envelope_version, e.destination_master_key_id, e.destination_nonce, e.destination_ciphertext FROM webhook_endpoints e WHERE e.id=$1 AND e.destination_master_key_id IS NOT NULL`
	case "signing-key":
		query = `SELECT 'signing-key', k.id::text, k.endpoint_id::text, e.owner_kind, e.owner_id::text, k.id::text, k.envelope_version, k.master_key_id, k.nonce, k.ciphertext FROM webhook_signing_keys k LEFT JOIN webhook_endpoints e ON e.id=k.endpoint_id WHERE k.id=$1`
	case "delivery-destination":
		query = `SELECT 'delivery-destination', d.id::text, d.endpoint_id::text, d.owner_kind, d.owner_id::text, d.id::text, d.destination_envelope_version, d.destination_master_key_id, d.destination_nonce, d.destination_ciphertext FROM webhook_deliveries d WHERE d.id=$1`
	default:
		return nil, fmt.Errorf("unknown webhook ciphertext kind")
	}
	var c store.WebhookCiphertext
	var ownerKind, ownerID *string
	err := db.QueryRow(ctx, query, id).Scan(&c.Kind, &c.ID, &c.EndpointID, &ownerKind, &ownerID, &c.RecordID, &c.Version, &c.MasterKeyID, &c.Nonce, &c.Ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read webhook recovery ciphertext", err)
	}
	if ownerKind == nil || ownerID == nil {
		return nil, fmt.Errorf("orphaned webhook signing key")
	}
	c.OwnerKind, c.OwnerID = *ownerKind, *ownerID
	return &c, nil
}
