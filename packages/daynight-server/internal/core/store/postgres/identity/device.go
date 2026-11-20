package identity

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func scanDevice(row pgx.Row) (model.DeviceAuthorization, error) {
	var d model.DeviceAuthorization
	err := row.Scan(&d.ID, &d.DeviceCodeHash, &d.UserCode, &d.Status, &d.UserID, &d.CreatedAt, &d.ExpiresAt, &d.NextPollAt, &d.PollIntervalSeconds, &d.ApprovedScopes)
	if err != nil {
		return d, err
	}
	if d.ApprovedScopes != nil {
		if _, err := scopepolicy.NewPolicy(scopepolicy.PAT, d.ApprovedScopes, 1); err != nil {
			return model.DeviceAuthorization{}, fmt.Errorf("invalid approved device scopes: %w", err)
		}
	}
	return d, nil
}

const deviceFields = `id::text,device_code_hash,user_code,status,user_id::text,created_at,expires_at,next_poll_at,poll_interval_seconds,approved_business_scopes`

func (s *scope) SetScopedDeviceDecision(ctx context.Context, id, status, user string, scopes []scopepolicy.ScopeID) error {
	if status == "approved" {
		if _, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1); err != nil {
			return err
		}
	} else if status != "denied" || scopes != nil {
		return fmt.Errorf("invalid scoped device decision")
	}
	_, err := s.tx.Exec(ctx, `UPDATE device_authorizations SET status=$2,user_id=$3,approved_business_scopes=$4 WHERE id=$1`, id, status, user, scopes)
	return pg.AuthQueryError("set scoped device decision", err)
}
