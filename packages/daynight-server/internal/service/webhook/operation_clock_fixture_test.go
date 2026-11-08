package webhook

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// Only operation time advances after an observed PostgreSQL lock wait. SQL
// ownership, credentials, transactions and persisted source facts stay real.
type operationClockStore struct {
	*postgres.Store
	advance atomic.Int64
}

type operationClockScope struct {
	store.WebhookWriteScope
	advance *atomic.Int64
}

func (s operationClockScope) ObservedAt(ctx context.Context) (time.Time, error) {
	now, err := s.WebhookWriteScope.ObservedAt(ctx)
	if err != nil {
		return now, err
	}
	return now.Add(time.Duration(s.advance.Load())), nil
}

func (d *operationClockStore) WriteWebhook(ctx context.Context, owner wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	return d.Store.WriteWebhook(ctx, owner, id, func(scope store.WebhookWriteScope) error {
		return fn(operationClockScope{WebhookWriteScope: scope, advance: &d.advance})
	})
}
