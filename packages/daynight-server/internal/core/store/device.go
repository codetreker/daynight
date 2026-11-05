package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func scanDevice(row pgx.Row) (model.DeviceAuthorization, error) {
	var d model.DeviceAuthorization
	err := row.Scan(&d.ID, &d.DeviceCodeHash, &d.UserCode, &d.Status, &d.UserID, &d.CreatedAt, &d.ExpiresAt, &d.NextPollAt, &d.PollIntervalSeconds)
	return d, err
}

const deviceFields = `id::text,device_code_hash,user_code,status,user_id::text,created_at,expires_at,next_poll_at,poll_interval_seconds`
