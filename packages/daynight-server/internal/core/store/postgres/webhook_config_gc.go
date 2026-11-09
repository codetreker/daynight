package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// Observe committed retirements first, then assign a later XID in the same
// READ COMMITTED transaction. A successful commit publishes that barrier.
func (s *Store) ScanWebhookConfigGC(ctx context.Context, after *store.WebhookConfigGCCandidate, limit int) (store.WebhookConfigGCScan, error) {
	if limit < 1 || limit > 500 {
		return store.WebhookConfigGCScan{}, fmt.Errorf("invalid webhook configuration collection limit")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.WebhookConfigGCScan{}, pg.QueryError("begin webhook collection scan", err)
	}
	var scan store.WebhookConfigGCScan
	order, id, revision := 0, "", int64(0)
	if after != nil {
		order, id, revision = after.Order, after.ID, after.Revision
	}
	err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `WITH candidates AS (
 SELECT 1 AS priority,'key' AS kind,k.id::text AS id,e.id::text AS endpoint,''::text AS project,e.owner_kind,e.owner_id::text AS owner,0::bigint AS revision
 FROM webhook_signing_keys k JOIN webhook_endpoints e ON e.id=k.endpoint_id
 WHERE k.slot='overlap' AND k.overlap_until<=statement_timestamp() AND e.active_key_id IS DISTINCT FROM k.id
 UNION ALL
 SELECT 2,'binding',b.id::text,e.id::text,s.project_id::text,e.owner_kind,e.owner_id::text,0::bigint
 FROM webhook_bindings b JOIN webhook_subscriptions s ON s.id=b.subscription_id JOIN webhook_endpoints e ON e.id=s.endpoint_id
 WHERE b.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_delivery_matches m WHERE m.binding_id=b.id)
 UNION ALL
 SELECT 3,'subscription',s.id::text,e.id::text,s.project_id::text,e.owner_kind,e.owner_id::text,0::bigint
 FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id=s.endpoint_id
 WHERE s.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_bindings b WHERE b.subscription_id=s.id) AND NOT EXISTS (SELECT 1 FROM webhook_delivery_matches m WHERE m.subscription_id=s.id)
 UNION ALL
 SELECT 4,'wait',e.id::text,e.id::text,''::text,e.owner_kind,e.owner_id::text,w.destination_revision
 FROM webhook_endpoint_waits w JOIN webhook_endpoints e ON e.id=w.endpoint_id
 WHERE (e.deleted_at IS NOT NULL OR e.destination_revision<>w.destination_revision) AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.destination_revision=w.destination_revision)
 UNION ALL
 SELECT 5,'endpoint',e.id::text,e.id::text,''::text,e.owner_kind,e.owner_id::text,0::bigint
 FROM webhook_endpoints e WHERE e.deleted_at IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM webhook_signing_keys k WHERE k.endpoint_id=e.id)
 AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.endpoint_id=e.id)
 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id=e.id)
 AND NOT EXISTS (SELECT 1 FROM webhook_operations o WHERE o.endpoint_id=e.id)
 AND NOT EXISTS (SELECT 1 FROM webhook_endpoint_waits w WHERE w.endpoint_id=e.id)
 ) SELECT priority,kind,id,endpoint,project,owner_kind,owner,revision FROM candidates WHERE (priority,id,revision)>($1,$2,$3) ORDER BY priority,id,revision LIMIT $4`, order, id, revision, limit)
		if err != nil {
			return pg.QueryError("scan webhook configuration collection", err)
		}
		for rows.Next() {
			var c store.WebhookConfigGCCandidate
			if err := rows.Scan(&c.Order, &c.Kind, &c.ID, &c.EndpointID, &c.ProjectID, &c.Owner.Kind, &c.Owner.ID, &c.Revision); err != nil {
				rows.Close()
				return pg.QueryError("scan webhook configuration collection", err)
			}
			scan.Candidates = append(scan.Candidates, c)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return pg.QueryError("scan webhook configuration collection", err)
		}
		if len(scan.Candidates) > 0 {
			if err = tx.QueryRow(ctx, `SELECT pg_current_xact_id()::text`).Scan(&scan.Barrier); err != nil {
				return pg.QueryError("allocate webhook collection barrier", err)
			}
		}
		return nil
	})
	if err != nil {
		return store.WebhookConfigGCScan{}, pg.QueryError("prepare webhook configuration collection", err)
	}
	return scan, nil
}

func (s *Store) WebhookConfigGCBarrierPassed(ctx context.Context, barrier string) (bool, error) {
	var passed bool
	err := s.Pool.QueryRow(ctx, `SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $1::xid8`, barrier).Scan(&passed)
	if err != nil {
		return false, pg.QueryError("read webhook collection barrier", err)
	}
	return passed, nil
}

type webhookConfigGCScope struct{ tx pgx.Tx }

func (s *Store) WriteWebhookConfigGC(ctx context.Context, c store.WebhookConfigGCCandidate, fn func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook configuration collection", err)
	}
	err = transactWebhookMaintenance(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout='50ms'`); err != nil {
			return pg.QueryError("bound webhook configuration locks", err)
		}
		projects := []string(nil)
		if c.ProjectID != "" {
			projects = append(projects, c.ProjectID)
		}
		sc := &webhookScope{&Snapshot{tx: tx}}
		if err := sc.LockConfigurationSources(ctx, c.Owner, c.Owner.ID, projects); err != nil {
			return err
		}
		return fn(&webhookConfigGCScope{tx: tx})
	})
	return teamCompletion("collect webhook configuration", err)
}

func (s *webhookConfigGCScope) LockConfigCandidate(ctx context.Context, c store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error) {
	var facts store.WebhookConfigGCFacts
	var deleted bool
	var revision int64
	var active *string
	err := s.tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,destination_revision,active_key_id::text FROM webhook_endpoints WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 FOR UPDATE`, c.EndpointID, c.Owner.Kind, c.Owner.ID).Scan(&deleted, &revision, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return facts, nil
	}
	if err != nil {
		return facts, pg.QueryError("lock webhook collection endpoint", err)
	}
	switch c.Kind {
	case "key":
		var slot string
		var expiry *time.Time
		err = s.tx.QueryRow(ctx, `SELECT slot,overlap_until,clock_timestamp() FROM webhook_signing_keys WHERE id=$1 AND endpoint_id=$2 FOR UPDATE`, c.ID, c.EndpointID).Scan(&slot, &expiry, &facts.ObservedAt)
		facts.Retired = slot == "overlap" && expiry != nil && (active == nil || *active != c.ID)
		if expiry != nil {
			facts.Expiry = *expiry
		}
	case "binding":
		var subscription string
		err = s.tx.QueryRow(ctx, `SELECT s.id::text FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE b.id=$1 AND s.endpoint_id=$2 AND s.project_id=$3 FOR UPDATE OF s`, c.ID, c.EndpointID, c.ProjectID).Scan(&subscription)
		if err == nil {
			err = s.tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM webhook_bindings WHERE id=$1 AND subscription_id=$2 FOR UPDATE`, c.ID, subscription).Scan(&facts.Retired)
		}
		if err == nil {
			err = s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_delivery_matches WHERE binding_id=$1)`, c.ID).Scan(&facts.Referenced)
		}
	case "subscription":
		err = s.tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM webhook_subscriptions WHERE id=$1 AND endpoint_id=$2 AND project_id=$3 FOR UPDATE`, c.ID, c.EndpointID, c.ProjectID).Scan(&facts.Retired)
		if err == nil {
			err = s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE subscription_id=$1) OR EXISTS(SELECT 1 FROM webhook_delivery_matches WHERE subscription_id=$1)`, c.ID).Scan(&facts.Referenced)
		}
	case "wait":
		var v int64
		err = s.tx.QueryRow(ctx, `SELECT destination_revision FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2 FOR UPDATE`, c.EndpointID, c.Revision).Scan(&v)
		facts.Retired = deleted || revision != c.Revision
		if err == nil {
			err = s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_deliveries WHERE endpoint_id=$1 AND destination_revision=$2)`, c.EndpointID, c.Revision).Scan(&facts.Referenced)
		}
	case "endpoint":
		facts.Retired = deleted
		err = s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_signing_keys WHERE endpoint_id=$1) OR EXISTS(SELECT 1 FROM webhook_subscriptions WHERE endpoint_id=$1) OR EXISTS(SELECT 1 FROM webhook_deliveries WHERE endpoint_id=$1) OR EXISTS(SELECT 1 FROM webhook_operations WHERE endpoint_id=$1) OR EXISTS(SELECT 1 FROM webhook_endpoint_waits WHERE endpoint_id=$1)`, c.EndpointID).Scan(&facts.Referenced)
	default:
		return facts, fmt.Errorf("invalid webhook collection candidate")
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return store.WebhookConfigGCFacts{}, nil
	}
	if err != nil {
		return facts, pg.QueryError("lock webhook collection candidate", err)
	}
	facts.Present = true
	return facts, nil
}

func (s *webhookConfigGCScope) DeleteConfigCandidate(ctx context.Context, c store.WebhookConfigGCCandidate) (bool, error) {
	var sql string
	switch c.Kind {
	case "key":
		sql = `DELETE FROM webhook_signing_keys WHERE id=$1 AND endpoint_id=$2 AND slot='overlap' AND overlap_until<=clock_timestamp()`
	case "binding":
		sql = `DELETE FROM webhook_bindings WHERE id=$1 AND subscription_id IN (SELECT id FROM webhook_subscriptions WHERE endpoint_id=$2) AND deleted_at IS NOT NULL`
	case "subscription":
		sql = `DELETE FROM webhook_subscriptions WHERE id=$1 AND endpoint_id=$2 AND deleted_at IS NOT NULL`
	case "wait":
		sql = `DELETE FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2`
	case "endpoint":
		sql = `DELETE FROM webhook_endpoints WHERE id=$1 AND id=$2 AND deleted_at IS NOT NULL`
	default:
		return false, fmt.Errorf("invalid webhook collection candidate")
	}
	var args []any
	if c.Kind == "wait" {
		args = []any{c.EndpointID, c.Revision}
	} else {
		args = []any{c.ID, c.EndpointID}
	}
	tag, err := s.tx.Exec(ctx, sql, args...)
	if err != nil {
		return false, pg.QueryError("delete webhook configuration candidate", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) ObserveWebhookConfigGC(ctx context.Context, c store.WebhookConfigGCCandidate) (bool, error) {
	var sql string
	switch c.Kind {
	case "key":
		sql = `SELECT EXISTS(SELECT 1 FROM webhook_signing_keys WHERE id=$1)`
	case "binding":
		sql = `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`
	case "subscription":
		sql = `SELECT EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=$1)`
	case "wait":
		sql = `SELECT EXISTS(SELECT 1 FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2)`
	case "endpoint":
		sql = `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1)`
	default:
		return false, fmt.Errorf("invalid webhook collection candidate")
	}
	args := []any{c.ID}
	if c.Kind == "wait" {
		args = []any{c.EndpointID, c.Revision}
	}
	var present bool
	err := s.Pool.QueryRow(ctx, sql, args...).Scan(&present)
	if err != nil {
		return false, pg.QueryError("observe webhook configuration candidate", err)
	}
	return present, nil
}

var _ store.WebhookConfigGC = (*Store)(nil)
