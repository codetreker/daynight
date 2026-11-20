package identity

import (
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
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
