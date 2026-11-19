package webhook

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.WebhookInboundSourceReader = (*DAO)(nil)

// PersonalDeliveryDestinations reads one page of the destination snapshots
// captured on the event's deliveries. The snapshot, not the endpoint's current
// configuration, names the target that delivery attempts use. The stored
// origin keeps the configured host case and any explicit port, so the
// comparison folds case, strips leading port zeros, and drops an empty or
// HTTPS-default ":443" port before comparing with the canonical origin. This
// prefilter is never narrower than the caller's exact target match; an origin
// has no path, so normalization never relaxes the inbox path match.
func (d *DAO) PersonalDeliveryDestinations(ctx context.Context, eventID, owner, origin, after string, limit int) ([]store.WebhookDeliveryDestination, error) {
	if _, err := model.CanonicalID(eventID); err != nil {
		return nil, nil
	}
	if after != "" {
		if _, err := model.CanonicalID(after); err != nil {
			return nil, nil
		}
	}
	rows, err := d.tx.Query(ctx, `SELECT id::text,destination_configuration FROM webhook_deliveries WHERE event_id=$1 AND owner_kind='personal' AND owner_id=$2 AND regexp_replace(regexp_replace(lower(destination_origin),':0*([0-9]+)$',':\1'),'^(https://.*):(443)?$','\1')=lower($3) AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5`, eventID, owner, origin, nullableID(after), limit)
	if err != nil {
		return nil, pg.QueryError("read webhook inbound deliveries", err)
	}
	defer rows.Close()
	var out []store.WebhookDeliveryDestination
	for rows.Next() {
		var destination store.WebhookDeliveryDestination
		if err := rows.Scan(&destination.DeliveryID, &destination.Configuration); err != nil {
			return nil, pg.QueryError("scan webhook inbound delivery", err)
		}
		out = append(out, destination)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook inbound deliveries", err)
	}
	return out, nil
}

func nullableID(id string) *string {
	if id == "" {
		return nil
	}
	return &id
}
