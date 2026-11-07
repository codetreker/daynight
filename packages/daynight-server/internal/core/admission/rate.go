// Package admission implements shared persistent window admission decisions.
package admission

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// RateStore is transaction-bound; its persistence methods are shared with the
// device flow. Callers supply independently namespaced hashes and limits.
type RateStore interface {
	PruneDeviceRates(context.Context, time.Time) error
	IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error)
}

// Take visits ordered buckets until one is exhausted. Callers must commit even
// when the result is false so the counters and pruning remain durable.
func Take(ctx context.Context, dao RateStore, buckets []model.DeviceRateBucket, now time.Time) (bool, error) {
	if err := dao.PruneDeviceRates(ctx, now); err != nil {
		return false, err
	}
	for _, bucket := range buckets {
		attempts, err := dao.IncrementDeviceRate(ctx, bucket, now)
		if err != nil {
			return false, err
		}
		if attempts > bucket.Limit {
			return false, nil
		}
	}
	return true, nil
}
