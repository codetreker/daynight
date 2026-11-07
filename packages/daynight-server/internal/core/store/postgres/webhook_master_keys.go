package postgres

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.WebhookMasterReferences = (*Store)(nil)

func (s *Store) WebhookMasterKeyIDs(ctx context.Context) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT master_key_id FROM (
 SELECT destination_master_key_id AS master_key_id FROM webhook_endpoints WHERE destination_master_key_id IS NOT NULL
 UNION SELECT master_key_id FROM webhook_signing_keys
 UNION SELECT destination_master_key_id FROM webhook_deliveries
) AS referenced ORDER BY master_key_id`)
	if err != nil {
		return nil, pg.QueryError("read webhook master key references", err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.QueryError("scan webhook master key references", err)
		}
		if id == "" {
			return nil, fmt.Errorf("invalid webhook master key reference")
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook master key references", err)
	}
	return result, nil
}
