//go:build stress

package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookConfigGCPreparedTransactionStress(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var maxPrepared int
	if err := s.Pool.QueryRow(ctx, `SELECT current_setting('max_prepared_transactions')::int`).Scan(&maxPrepared); err != nil {
		t.Fatal(err)
	}
	if maxPrepared == 0 {
		t.Fatal("prepared transactions must be enabled for this stress test")
	}
	owner, ep, _, op := webhookStoredFixture(t)
	now := time.Now().UTC()
	sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: ep.ID, ProjectID: uuid.NewString(), Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	binding := webhook.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now, DeletedAt: &now}
	_, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		if err := w.PutEndpoint(ctx, ep); err != nil {
			return err
		}
		if err := w.PutSubscription(ctx, sub); err != nil {
			return err
		}
		return w.PutBinding(ctx, binding)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, `CREATE TABLE gc_prepared_probe(id int PRIMARY KEY, n int NOT NULL); INSERT INTO gc_prepared_probe VALUES (1,0)`); err != nil {
		t.Fatal(err)
	}
	connection, err := s.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	if _, err = connection.Exec(ctx, `BEGIN`); err != nil {
		t.Fatal(err)
	}
	if _, err = connection.Exec(ctx, `UPDATE gc_prepared_probe SET n=n+1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	prepared := "t06_gc_" + uuid.NewString()
	if _, err = connection.Exec(ctx, fmt.Sprintf("PREPARE TRANSACTION '%s'", prepared)); err != nil {
		t.Fatal(err)
	}
	preparedLive := true
	defer func() {
		if preparedLive {
			_, _ = s.Pool.Exec(context.Background(), fmt.Sprintf("ROLLBACK PREPARED '%s'", prepared))
		}
	}()
	collector := &core.ConfigCollector{}
	n, err := collector.Pass(ctx, s, 1)
	if err != nil || n != 0 {
		t.Fatalf("while prepared: %d %v", n, err)
	}
	var present bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || !present {
		t.Fatalf("while prepared present=%v err=%v", present, err)
	}
	if _, err = s.Pool.Exec(ctx, fmt.Sprintf("COMMIT PREPARED '%s'", prepared)); err != nil {
		t.Fatal(err)
	}
	preparedLive = false
	for i := 0; i < 100 && present; i++ {
		_, err = collector.Pass(ctx, s, 1)
		if err != nil {
			t.Fatal(err)
		}
		if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if present {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if present {
		t.Fatal("binding remained after COMMIT PREPARED")
	}
}
