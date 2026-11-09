package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

var _ store.WebhookStartupReader = (*Store)(nil)

func (s *Store) WebhookStartupPolicies(ctx context.Context) ([]model.Policy, error) {
	rows, err := s.Pool.Query(ctx, `SELECT version,max_automatic_attempts,automatic_window_seconds,automatic_offsets_seconds,max_manual_operations,payload_retention_seconds,metadata_retention_seconds,operation_retention_seconds,operation_max_age_seconds,operation_future_skew_seconds,http_timeout_seconds,lease_seconds,minimum_failure_wait_seconds,jitter_basis_points,jitter_max_seconds,key_overlap_default_seconds,key_overlap_max_seconds FROM webhook_policies ORDER BY version`)
	if err != nil {
		return nil, pg.QueryError("read webhook startup policies", err)
	}
	defer rows.Close()
	var policies []model.Policy
	for rows.Next() {
		var p model.Policy
		if err := rows.Scan(&p.Version, &p.MaxAutomaticAttempts, &p.AutomaticWindowSeconds, &p.AutomaticOffsetsSeconds, &p.MaxManualOperations, &p.PayloadRetentionSeconds, &p.MetadataRetentionSeconds, &p.OperationRetentionSeconds, &p.OperationMaxAgeSeconds, &p.OperationFutureSkewSeconds, &p.HTTPTimeoutSeconds, &p.LeaseSeconds, &p.MinimumFailureWaitSeconds, &p.JitterBasisPoints, &p.JitterMaxSeconds, &p.KeyOverlapDefaultSeconds, &p.KeyOverlapMaxSeconds); err != nil {
			return nil, pg.QueryError("scan webhook startup policies", err)
		}
		policies = append(policies, p)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook startup policies", err)
	}
	return policies, nil
}

// All relationships are checked in one statement snapshot: configuration
// changes may replace keys and revision waits atomically in other transactions.
func (s *Store) CheckWebhookCurrentReferences(ctx context.Context) error {
	var invalid bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM webhook_endpoints e WHERE e.deleted_at IS NULL AND (
  NOT EXISTS (SELECT 1 FROM webhook_signing_keys k WHERE k.id=e.active_key_id AND k.endpoint_id=e.id AND k.slot='current') OR
  NOT EXISTS (SELECT 1 FROM webhook_endpoint_waits w WHERE w.endpoint_id=e.id AND w.destination_revision=e.destination_revision AND w.owner_kind=e.owner_kind AND w.owner_id=e.owner_id)
 )
 UNION ALL
 SELECT 1 FROM webhook_deliveries d WHERE NOT EXISTS (SELECT 1 FROM webhook_policies p WHERE p.version=d.policy_version)
 )`).Scan(&invalid)
	if err != nil {
		return pg.QueryError("check webhook startup references", err)
	}
	if invalid {
		return errors.New("invalid webhook current references")
	}
	return nil
}
