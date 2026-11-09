package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.SessionMediaRateDAO = (*DAO)(nil)

func (tx *DAO) TakeSessionMediaRate(ctx context.Context, owner, category string, now time.Time, rate, burst int) (bool, error) {
	if (category != "prepare" && category != "control" && category != "observe" && category != "release") || rate < 1 || rate > 20 || burst < 1 || burst > 40 || now.IsZero() {
		return false, &model.Fault{Code: "invalid_input", Message: "Invalid persistent media admission policy."}
	}
	const unit int64 = 1_000_000
	capacity := int64(burst) * unit
	if _, err := tx.tx.Exec(ctx, `INSERT INTO session_media_rates(owner_user_id,category,tokens,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,category) DO NOTHING`, owner, category, capacity, now); err != nil {
		return false, mediaQueryError("initialize account media rate", err)
	}
	var tokens int64
	var previous time.Time
	if err := tx.tx.QueryRow(ctx, `SELECT tokens,updated_at FROM session_media_rates WHERE owner_user_id=$1 AND category=$2 FOR UPDATE`, owner, category).Scan(&tokens, &previous); err != nil {
		return false, mediaQueryError("lock account media rate", err)
	}
	elapsed := now.Sub(previous).Microseconds()
	if elapsed < 0 {
		elapsed = 0
		now = previous
	}
	// Bound before multiplication, including clocks that advance by years.
	if elapsed >= (capacity+int64(rate)-1)/int64(rate) {
		tokens = capacity
	} else {
		tokens = min(capacity, tokens+elapsed*int64(rate))
	}
	allowed := tokens >= unit
	if allowed {
		tokens -= unit
	}
	_, err := tx.tx.Exec(ctx, `UPDATE session_media_rates SET tokens=$3,updated_at=$4 WHERE owner_user_id=$1 AND category=$2`, owner, category, tokens, now)
	return allowed, mediaQueryError("persist account media rate", err)
}
