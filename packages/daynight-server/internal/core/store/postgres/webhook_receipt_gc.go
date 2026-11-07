package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ExpiredWebhookReceipts(ctx context.Context, after *store.WebhookReceiptIdentity, limit int) ([]store.WebhookReceiptIdentity, error) {
	if limit < 1 || limit > 500 {
		return nil, fmt.Errorf("invalid webhook receipt collection limit")
	}
	kind, owner, operation := "", "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000"
	if after != nil {
		kind, owner, operation = after.Owner.Kind, after.Owner.ID, after.OperationID
	}
	rows, err := s.Pool.Query(ctx, `SELECT owner_kind,owner_id::text,operation_id::text FROM webhook_operations WHERE expires_at <= statement_timestamp() AND ($1='' OR (owner_kind,owner_id,operation_id)>($1,$2::uuid,$3::uuid)) ORDER BY owner_kind,owner_id,operation_id LIMIT $4`, kind, owner, operation, limit)
	if err != nil {
		return nil, pg.QueryError("scan expired webhook receipts", err)
	}
	defer rows.Close()
	var ids []store.WebhookReceiptIdentity
	for rows.Next() {
		var id store.WebhookReceiptIdentity
		if err := rows.Scan(&id.Owner.Kind, &id.Owner.ID, &id.OperationID); err != nil {
			return nil, pg.QueryError("scan expired webhook receipts", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("scan expired webhook receipts", err)
	}
	return ids, nil
}

type webhookReceiptGCScope struct{ tx pgx.Tx }

func (s *Store) ObserveWebhookReceipt(ctx context.Context, id store.WebhookReceiptIdentity) (time.Time, bool, error) {
	var expiry time.Time
	err := s.Pool.QueryRow(ctx, `SELECT expires_at FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, id.Owner.Kind, id.Owner.ID, id.OperationID).Scan(&expiry)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, pg.QueryError("observe webhook receipt", err)
	}
	return expiry, true, nil
}

func (s *Store) WriteWebhookReceiptGC(ctx context.Context, id store.WebhookReceiptIdentity, fn func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	owner, e1 := uuid.Parse(id.Owner.ID)
	operation, e2 := uuid.Parse(id.OperationID)
	if e1 != nil || e2 != nil || (id.Owner.Kind != "personal" && id.Owner.Kind != "team") {
		return store.Completion{Outcome: store.TransactionNotCommitted}, fmt.Errorf("invalid webhook receipt identity")
	}
	id.Owner.ID, id.OperationID = owner.String(), operation.String()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook receipt collection", err)
	}
	err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error {
		sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + id.Owner.Kind + "\x00" + id.Owner.ID + "\x00" + id.OperationID))
		var acquired bool
		if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(sum[:8]))).Scan(&acquired); err != nil {
			return pg.QueryError("fence webhook operation", err)
		}
		if !acquired {
			return store.ErrWebhookReceiptFenceBusy
		}
		return fn(&webhookReceiptGCScope{tx: tx})
	})
	return teamCompletion("collect webhook receipt", err)
}

func (s *webhookReceiptGCScope) ReceiptExpiry(ctx context.Context, id store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
	var expiry, now time.Time
	err := s.tx.QueryRow(ctx, `SELECT expires_at FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3 FOR UPDATE`, id.Owner.Kind, id.Owner.ID, id.OperationID).Scan(&expiry)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, time.Time{}, false, pg.QueryError("lock webhook receipt", err)
	}
	if err := s.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, time.Time{}, false, pg.QueryError("read webhook receipt collection time", err)
	}
	return expiry, now, true, nil
}

func (s *webhookReceiptGCScope) DeleteReceipt(ctx context.Context, id store.WebhookReceiptIdentity) (bool, error) {
	tag, err := s.tx.Exec(ctx, `DELETE FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3 AND expires_at <= clock_timestamp()`, id.Owner.Kind, id.Owner.ID, id.OperationID)
	if err != nil {
		return false, pg.QueryError("delete expired webhook receipt", err)
	}
	return tag.RowsAffected() == 1, nil
}

var _ store.WebhookReceiptGC = (*Store)(nil)
