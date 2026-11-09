package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Mutations and observations have separate account buckets so exhausted input
// admission cannot prevent querying or releasing an earlier uncertain identity.
func (s *Execution) admitImageRate(ctx context.Context, tx *operationTx, actorID, category string) error {
	dao, ok := tx.dao.(store.SessionMediaRateDAO)
	if !ok {
		return fault("component_unsupported", "Persistent media admission requires a server upgrade.")
	}
	take := func(kind string, rate, burst int) error {
		allowed, err := dao.TakeSessionMediaRate(ctx, actorID, kind, s.now(), rate, burst)
		if err != nil {
			return err
		}
		if !allowed {
			return fault("rate_limited", "The account media request rate is exhausted.")
		}
		return nil
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
