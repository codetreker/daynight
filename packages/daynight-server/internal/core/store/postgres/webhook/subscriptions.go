package webhook

import (
	"context"
	"fmt"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

func scanSubscription(row pgx.Row) (model.Subscription, error) {
	var s model.Subscription
	err := row.Scan(&s.ID, &s.EndpointID, &s.ProjectID, &s.Owner.Kind, &s.Owner.ID, &s.AuthorizationState, &s.AuthorizationEpoch, &s.CreatedAt, &s.UpdatedAt, &s.DeletedAt)
	if err == nil && (s.AuthorizationEpoch <= 0 || (s.AuthorizationState != "active" && s.AuthorizationState != "confirmation_required")) {
		err = fmt.Errorf("invalid subscription authorization")
	}
	return s, err
}

func (d *DAO) subscriptions(ctx context.Context, endpointID, lock string) ([]model.Subscription, error) {
	rows, err := d.tx.Query(ctx, `SELECT id::text,endpoint_id::text,project_id::text,owner_kind,owner_id::text,authorization_state,authorization_epoch,created_at,updated_at,deleted_at FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL ORDER BY id`+lock, endpointID)
	if err != nil {
		return nil, pg.QueryError("read webhook subscriptions", err)
	}
	defer rows.Close()
	result := make([]model.Subscription, 0)
	for rows.Next() {
		s, err := scanSubscription(rows)
		if err != nil {
			return nil, pg.QueryError("read webhook subscriptions", err)
		}
		result = append(result, s)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook subscriptions", err)
	}
	return result, nil
}
func (d *DAO) Subscriptions(ctx context.Context, endpointID string) ([]model.Subscription, error) {
	return d.subscriptions(ctx, endpointID, "")
}
func (d *DAO) LockSubscriptions(ctx context.Context, endpointID string) ([]model.Subscription, error) {
	subscriptions, err := d.subscriptions(ctx, endpointID, " FOR UPDATE")
	if err != nil {
		return nil, err
	}
	rows, err := d.tx.Query(ctx, `SELECT b.id FROM webhook_bindings b JOIN webhook_subscriptions s ON s.id=b.subscription_id WHERE s.endpoint_id=$1 AND s.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY b.id FOR UPDATE OF b`, endpointID)
	if err != nil {
		return nil, pg.QueryError("lock webhook bindings", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, pg.QueryError("lock webhook bindings", err)
		}
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("lock webhook bindings", err)
	}
	return subscriptions, nil
}
func (d *DAO) Bindings(ctx context.Context, subscriptionID string) ([]model.Binding, error) {
	rows, err := d.tx.Query(ctx, `SELECT id::text,subscription_id::text,event_type,created_at,deleted_at FROM webhook_bindings WHERE subscription_id=$1 AND deleted_at IS NULL ORDER BY id`, subscriptionID)
	if err != nil {
		return nil, pg.QueryError("read webhook bindings", err)
	}
	defer rows.Close()
	result := make([]model.Binding, 0)
	for rows.Next() {
		var b model.Binding
		if err = rows.Scan(&b.ID, &b.SubscriptionID, &b.EventType, &b.CreatedAt, &b.DeletedAt); err != nil {
			return nil, pg.QueryError("read webhook bindings", err)
		}
		result = append(result, b)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook bindings", err)
	}
	return result, nil
}
func (d *DAO) PutSubscription(ctx context.Context, s model.Subscription) error {
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at,deleted_at)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE EXISTS (SELECT 1 FROM webhook_endpoints WHERE id=$2 AND owner_kind=$4 AND owner_id=$5)
 ON CONFLICT(id) DO UPDATE SET authorization_state=EXCLUDED.authorization_state,authorization_epoch=EXCLUDED.authorization_epoch,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at
 WHERE webhook_subscriptions.endpoint_id=EXCLUDED.endpoint_id AND webhook_subscriptions.project_id=EXCLUDED.project_id AND webhook_subscriptions.owner_kind=EXCLUDED.owner_kind AND webhook_subscriptions.owner_id=EXCLUDED.owner_id AND webhook_subscriptions.deleted_at IS NULL`, s.ID, s.EndpointID, s.ProjectID, s.Owner.Kind, s.Owner.ID, s.AuthorizationState, s.AuthorizationEpoch, s.CreatedAt, s.UpdatedAt, s.DeletedAt)
	if err != nil {
		return pg.QueryError("save webhook subscription", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("subscription identity or owner mismatch")
	}
	return nil
}
func (d *DAO) PutBinding(ctx context.Context, b model.Binding) error {
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at,deleted_at) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(id) DO UPDATE SET deleted_at=EXCLUDED.deleted_at WHERE webhook_bindings.subscription_id=EXCLUDED.subscription_id AND webhook_bindings.event_type=EXCLUDED.event_type AND webhook_bindings.deleted_at IS NULL`, b.ID, b.SubscriptionID, b.EventType, b.CreatedAt, b.DeletedAt)
	if err != nil {
		return pg.QueryError("save webhook binding", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("binding identity mismatch")
	}
	return nil
}
