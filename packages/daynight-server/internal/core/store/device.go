package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func (s *Store) TakeDeviceRate(ctx context.Context, buckets []core.DeviceRateBucket, now time.Time) (bool, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, authQueryError("begin device limit", err)
	}
	allowed := true
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM device_authorization_limits WHERE bucket_hash IN (SELECT bucket_hash FROM device_authorization_limits WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now); err != nil {
			return err
		}
		for _, bucket := range buckets {
			var attempts int
			err := tx.QueryRow(ctx, `INSERT INTO device_authorization_limits (bucket_hash,attempts,expires_at) VALUES ($1,1,$2) ON CONFLICT (bucket_hash) DO UPDATE SET attempts=CASE WHEN device_authorization_limits.expires_at <= $4 THEN 1 ELSE LEAST(device_authorization_limits.attempts+1,$3) END, expires_at=CASE WHEN device_authorization_limits.expires_at <= $4 THEN EXCLUDED.expires_at ELSE device_authorization_limits.expires_at END RETURNING attempts`, bucket.Hash, now.Add(time.Minute), bucket.Limit+1, now).Scan(&attempts)
			if err != nil {
				return err
			}
			if attempts > bucket.Limit {
				allowed = false
				break
			}
		}
		return nil
	})
	return allowed, authQueryError("device limit", err)
}

func (s *Store) CreateDeviceAuthorization(ctx context.Context, d core.DeviceAuthorization) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return authQueryError("begin device authorization", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM device_authorizations WHERE id IN (SELECT id FROM device_authorizations WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, d.CreatedAt.Add(-time.Hour)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO device_authorizations (id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)`, d.ID, d.DeviceCodeHash, d.UserCode, d.CreatedAt, d.ExpiresAt, d.NextPollAt, d.PollIntervalSeconds)
		return err
	})
	return authQueryError("create device authorization", err)
}

func scanDevice(row pgx.Row) (core.DeviceAuthorization, error) {
	var d core.DeviceAuthorization
	err := row.Scan(&d.ID, &d.DeviceCodeHash, &d.UserCode, &d.Status, &d.UserID, &d.CreatedAt, &d.ExpiresAt, &d.NextPollAt, &d.PollIntervalSeconds)
	return d, err
}

const deviceFields = `id::text,device_code_hash,user_code,status,user_id::text,created_at,expires_at,next_poll_at,poll_interval_seconds`

func (s *Store) InspectDeviceAuthorization(ctx context.Context, p core.Principal, code string, now time.Time) (core.DeviceAuthorization, error) {
	var d core.DeviceAuthorization
	err := s.withSession(ctx, p, now, func(tx pgx.Tx) error {
		var err error
		d, err = scanDevice(tx.QueryRow(ctx, `SELECT `+deviceFields+` FROM device_authorizations WHERE user_code=$1 AND (user_id IS NULL OR user_id=$2)`, code, p.UserID))
		return err
	})
	return d, err
}

func (s *Store) DecideDeviceAuthorization(ctx context.Context, p core.Principal, code, status string, now time.Time) (string, error) {
	outcome := ""
	err := s.withSession(ctx, p, now, func(tx pgx.Tx) error {
		d, err := scanDevice(tx.QueryRow(ctx, `SELECT `+deviceFields+` FROM device_authorizations WHERE user_code=$1 AND (user_id IS NULL OR user_id=$2) FOR UPDATE`, code, p.UserID))
		if err != nil {
			return err
		}
		if !d.ExpiresAt.After(now) {
			outcome = "expired"
			return nil
		}
		if d.Status != "pending" {
			outcome = d.Status
			return nil
		}
		_, err = tx.Exec(ctx, `UPDATE device_authorizations SET status=$2,user_id=$3 WHERE id=$1`, d.ID, status, p.UserID)
		return err
	})
	return outcome, err
}

// A successful redemption consumes the grant and inserts its credential in one commit.
func (s *Store) RedeemDeviceAuthorization(ctx context.Context, hash []byte, c core.PersonalAccessToken) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", authQueryError("begin device redemption", err)
	}
	outcome := ""
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		d, err := scanDevice(tx.QueryRow(ctx, `SELECT `+deviceFields+` FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE`, hash))
		if errors.Is(err, pgx.ErrNoRows) {
			outcome = "invalid_grant"
			return nil
		}
		if err != nil {
			return err
		}
		switch {
		case d.Status == "consumed":
			outcome = "invalid_grant"
			return nil
		case !d.ExpiresAt.After(c.CreatedAt):
			outcome = "expired_token"
			return nil
		case d.Status == "denied":
			outcome = "access_denied"
			return nil
		}
		if c.CreatedAt.Before(d.NextPollAt) {
			outcome = "slow_down"
			_, err = tx.Exec(ctx, `UPDATE device_authorizations SET poll_interval_seconds=poll_interval_seconds+5,next_poll_at=$2::timestamptz+(poll_interval_seconds+5)*interval '1 second' WHERE id=$1`, d.ID, c.CreatedAt)
			return err
		}
		if d.Status == "pending" {
			outcome = "authorization_pending"
			_, err = tx.Exec(ctx, `UPDATE device_authorizations SET next_poll_at=$2::timestamptz+poll_interval_seconds*interval '1 second' WHERE id=$1`, d.ID, c.CreatedAt)
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, c.ID, *d.UserID, c.TokenHash, c.Name, c.CreatedAt, c.ExpiresAt); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE device_authorizations SET status='consumed' WHERE id=$1`, d.ID)
		return err
	})
	return outcome, authQueryError("redeem device authorization", err)
}

func (s *Store) DeleteCurrentPAT(ctx context.Context, p core.Principal) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1 AND user_id=$2`, p.CredentialID, p.UserID)
	return authQueryError("delete current token", err)
}
