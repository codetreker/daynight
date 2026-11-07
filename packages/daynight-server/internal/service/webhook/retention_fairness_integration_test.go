package webhook_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type slowConfigScan struct {
	*postgres.Store
	slow bool
}

func (s *slowConfigScan) ScanWebhookConfigGC(ctx context.Context, after *store.WebhookConfigGCCandidate, limit int) (store.WebhookConfigGCScan, error) {
	if !s.slow {
		s.slow = true
		<-ctx.Done()
		return store.WebhookConfigGCScan{}, ctx.Err()
	}
	return s.Store.ScanWebhookConfigGC(ctx, after, limit)
}
func TestRetentionContinuesOtherClassesAfterConfigTimeout(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	db := &slowConfigScan{Store: f.db}
	gc := webhook.NewRetention(db)
	started := time.Now()
	_, more, err := gc.Pass(f.ctx)
	if err != nil || !more || time.Since(started) > 2500*time.Millisecond {
		t.Fatalf("bounded pass: more=%v elapsed=%v err=%v", more, time.Since(started), err)
	}
	if _, _, err = gc.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var removed bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT body IS NULL FROM webhook_deliveries WHERE id=$1`, id).Scan(&removed); err != nil || !removed {
		t.Fatalf("payload did not progress: %v", err)
	}
}
