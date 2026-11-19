package webhook

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.WebhookInboundSourceReader = (*DAO)(nil)

// PersonalDeliveryDestinations reads the destination snapshots captured on
// the event's deliveries. The snapshot, not the endpoint's current
// configuration, names the target that delivery attempts use.
func (d *DAO) PersonalDeliveryDestinations(ctx context.Context, eventID, owner, origin string, limit int) ([][]byte, error) {
	if _, err := model.CanonicalID(eventID); err != nil {
		return nil, nil
	}
	rows, err := d.tx.Query(ctx, `SELECT destination_configuration FROM webhook_deliveries WHERE event_id=$1 AND owner_kind='personal' AND owner_id=$2 AND destination_origin=$3 ORDER BY id LIMIT $4`, eventID, owner, origin, limit)
	if err != nil {
		return nil, pg.QueryError("read webhook inbound deliveries", err)
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var configuration []byte
		if err := rows.Scan(&configuration); err != nil {
			return nil, pg.QueryError("scan webhook inbound delivery", err)
		}
		out = append(out, configuration)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook inbound deliveries", err)
	}
	return out, nil
}
