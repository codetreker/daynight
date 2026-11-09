package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const imageRateUnit int64 = 1_000_000

// replenishImageRate owns the account admission policy. Persisted facts are
// checked before arithmetic; a corrupt bucket must not silently mint capacity.
func replenishImageRate(previous store.SessionMediaRate, now time.Time, rate, burst int) (store.SessionMediaRate, bool, error) {
	if rate < 1 || rate > 20 || burst < 1 || burst > 40 || now.IsZero() {
		return store.SessionMediaRate{}, false, fault("invalid_input", "Invalid persistent media admission policy.")
	}
	capacity := int64(burst) * imageRateUnit
	if previous.Tokens < 0 || previous.Tokens > capacity || previous.UpdatedAt.IsZero() {
		return store.SessionMediaRate{}, false, fault("source_corrupt", "Persistent media admission state is invalid.")
	}
	if now.Before(previous.UpdatedAt) {
		now = previous.UpdatedAt
	}
	elapsed := now.Sub(previous.UpdatedAt).Microseconds()
	tokens := previous.Tokens
	// Bound before multiplication, including clocks that advance by years.
	if elapsed >= (capacity+int64(rate)-1)/int64(rate) {
		tokens = capacity
	} else {
		tokens = min(capacity, tokens+elapsed*int64(rate))
	}
	allowed := tokens >= imageRateUnit
	if allowed {
		tokens -= imageRateUnit
	}
	return store.SessionMediaRate{Tokens: tokens, UpdatedAt: now}, allowed, nil
}

// Mutations and observations have separate account buckets so exhausted input
// admission cannot prevent querying or releasing an earlier uncertain identity.
func (s *Execution) admitImageRate(ctx context.Context, tx *operationTx, actorID, category string) error {
	dao, ok := tx.dao.(store.SessionMediaRateDAO)
	if !ok {
		return fault("component_unsupported", "Persistent media admission requires a server upgrade.")
	}
	now := s.now()
	if now.IsZero() {
		return fault("invalid_input", "Invalid persistent media admission clock.")
	}
	take := func(kind string, rate, burst int) error {
		initial := store.SessionMediaRate{Tokens: int64(burst) * imageRateUnit, UpdatedAt: now}
		previous, err := dao.LockSessionMediaRate(ctx, actorID, kind, initial)
		if err != nil {
			return err
		}
		next, allowed, err := replenishImageRate(previous, now, rate, burst)
		if err != nil {
			return err
		}
		if !allowed {
			return fault("rate_limited", "The account media request rate is exhausted.")
		}
		return dao.SaveSessionMediaRate(ctx, actorID, kind, next)
	}
	switch category {
	case "prepare":
		if err := take("control", 20, 40); err != nil {
			return err
		}
		return take("prepare", 2, 8)
	case "control", "observe", "release":
		return take(category, 20, 40)
	default:
		return fault("invalid_input", "Unknown media admission category.")
	}
}
