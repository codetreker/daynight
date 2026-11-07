package webhook

import (
	"context"
	"encoding/base64"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type claimStopStore struct {
	entered   chan struct{}
	cancelled *atomic.Int64
}
type claimStopScope struct {
	store.WebhookDeliveryScope
	owner *claimStopStore
}

func (s claimStopScope) ObservedAt(context.Context) (time.Time, error) { return time.Now(), nil }
func (s claimStopScope) LockExpired(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
	return nil, nil
}
func (s claimStopScope) LockDueExpiry(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
	return nil, nil
}
func (s claimStopScope) Claim(ctx context.Context, _ int, _ time.Time, _ []string) ([]store.WebhookDelivery, error) {
	if ctx.Err() != nil {
		s.owner.cancelled.Add(1)
		return nil, ctx.Err()
	}
	s.owner.entered <- struct{}{}
	<-ctx.Done()
	return nil, ctx.Err()
}
func (s *claimStopStore) WriteWebhookDelivery(ctx context.Context, f func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	err := f(claimStopScope{owner: s})
	if err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestRootCancellationStopsClaimsBeforeWorkCancellation(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(make([]byte, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + encoded + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	var cancelled atomic.Int64
	db := &claimStopStore{entered: make(chan struct{}, deliveryWorkers*2), cancelled: &cancelled}
	runner := NewRunner(db, &Service{Keys: keys}, true)
	work, stopWork := context.WithCancel(context.Background())
	defer stopWork()
	root, stopRoot := context.WithCancel(context.Background())
	defer stopRoot()
	if err = runner.StartWithClaimContext(work, root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = runner.Stop(ctx)
	})
	for i := 0; i < deliveryWorkers; i++ {
		select {
		case <-db.entered:
		case err := <-runner.Failures():
			t.Fatalf("worker failed: %v", err)
		case <-time.After(5 * time.Second):
			t.Fatal("workers did not claim")
		}
	}
	stopRoot()
	if work.Err() != nil {
		t.Fatal("root cancellation canceled in-flight work context")
	}
	select {
	case <-db.entered:
		t.Fatal("new claim after root cancellation")
	case <-time.After(100 * time.Millisecond):
	}
	if cancelled.Load() != 0 {
		t.Fatal("entered claim with canceled context")
	}
	select {
	case err := <-runner.Failures():
		t.Fatalf("normal claim cancellation marked failed: %v", err)
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = runner.Stop(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
