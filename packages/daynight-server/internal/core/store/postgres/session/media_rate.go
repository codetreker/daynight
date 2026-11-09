package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

var _ store.SessionMediaRateDAO = (*DAO)(nil)

func (tx *DAO) LockSessionMediaRate(ctx context.Context, owner, category string, initial store.SessionMediaRate) (store.SessionMediaRate, error) {
	if _, err := tx.tx.Exec(ctx, `INSERT INTO session_media_rates(owner_user_id,category,tokens,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,category) DO NOTHING`, owner, category, initial.Tokens, initial.UpdatedAt); err != nil {
		return store.SessionMediaRate{}, mediaQueryError("initialize account media rate", err)
	}
	// A prepare request updates control and prepare buckets in one authorized
	// transaction. Locking each account bucket avoids replaying that whole decision
	// after a second-bucket CAS conflict; all callers lock control before prepare.
	// These row locks cover only database work and never decoder or file I/O.
	var current store.SessionMediaRate
	err := tx.tx.QueryRow(ctx, `SELECT tokens,updated_at FROM session_media_rates WHERE owner_user_id=$1 AND category=$2 FOR UPDATE`, owner, category).Scan(&current.Tokens, &current.UpdatedAt)
	return current, mediaQueryError("lock account media rate", err)
}

func (tx *DAO) SaveSessionMediaRate(ctx context.Context, owner, category string, next store.SessionMediaRate) error {
	result, err := tx.tx.Exec(ctx, `UPDATE session_media_rates SET tokens=$3,updated_at=$4 WHERE owner_user_id=$1 AND category=$2`, owner, category, next.Tokens, next.UpdatedAt)
	if err == nil && result.RowsAffected() != 1 {
		err = pgx.ErrNoRows
	}
	return mediaQueryError("persist account media rate", err)
}
