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

func TestWebhookConfigGCKeyExpiryWithoutOwner(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, ep, key, op := webhookStoredFixture(t)
	old := key
	old.ID = uuid.NewString()
	old.Slot = "overlap"
	start := time.Now().UTC().Add(-48 * time.Hour)
	expired := time.Now().UTC().Add(-24 * time.Hour)
	old.OverlapStartedAt = &start
	old.OverlapUntil = &expired
	completion, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		if err := w.PutEndpoint(ctx, ep); err != nil {
			return err
		}
		if err := w.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return w.PutSigningKey(ctx, old)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("fixture %v %v", completion, err)
	}
	collector := &core.ConfigCollector{}
	removed := 0
	for i := 0; i < 100 && removed == 0; i++ {
		removed, err = collector.Pass(ctx, passedConfigBarrier{s}, 1)
		if err != nil {
			t.Fatal(err)
		}
		if removed == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if removed != 1 {
		t.Fatalf("removed=%d", removed)
	}
	var currents, overlaps int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE slot='current'),count(*) FILTER (WHERE slot='overlap') FROM webhook_signing_keys WHERE endpoint_id=$1`, ep.ID).Scan(&currents, &overlaps); err != nil || currents != 1 || overlaps != 0 {
		t.Fatalf("current=%d overlap=%d err=%v", currents, overlaps, err)
	}
	var users int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, owner.ID).Scan(&users); err != nil || users != 0 {
		t.Fatalf("owner fixture count=%d err=%v", users, err)
	}
}

func TestWebhookConfigGCWaitsForUnrelatedTransaction(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
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
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
		t.Fatal(err)
	}
	collector := &core.ConfigCollector{}
	n, err := collector.Pass(ctx, s, 1)
	if err != nil || n != 0 {
		t.Fatalf("while unrelated transaction active: %d %v", n, err)
	}
	var present bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || !present {
		t.Fatalf("retired binding: %v %v", present, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Other packages may retain unrelated XIDs in the same PostgreSQL cluster.
	// Continue with an explicitly passed barrier to test the locked recheck;
	// the prepared-transaction stress test proves real barrier convergence.
	for i := 0; i < 100 && present; i++ {
		_, err = collector.Pass(ctx, passedConfigBarrier{s}, 1)
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
		t.Fatal("retired binding was not reclaimed after barrier")
	}
}

// This test exercises lock timeouts after a successful barrier. PostgreSQL's
// actual cluster-wide barrier is covered independently, including prepared
// transactions; parallel suites may otherwise keep an unrelated XID active.
type passedConfigBarrier struct{ *Store }

func (s passedConfigBarrier) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return true, nil
}

func TestWebhookConfigGCBusyCandidateDoesNotBlockBatch(t *testing.T) {
	for _, lockKind := range []string{"endpoint", "project"} {
		t.Run(lockKind, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			team := uuid.NewString()
			if _, err := s.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'gc')`, team); err != nil {
				t.Fatal(err)
			}
			var firstEndpoint, firstProject string
			for i := 1; i <= 2; i++ {
				owner, ep, _, op := webhookStoredFixture(t)
				project := uuid.NewString()
				if _, err := s.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'gc','gc')`, project); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Pool.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team); err != nil {
					t.Fatal(err)
				}
				now := time.Now().UTC()
				sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: ep.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
				binding := webhook.Binding{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now, DeletedAt: &now}
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
				if i == 1 {
					firstEndpoint, firstProject = ep.ID, project
				}
			}
			lock, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			if lockKind == "project" {
				_, err = lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, firstProject)
			} else {
				_, err = lock.Exec(ctx, `SELECT id FROM webhook_endpoints WHERE id=$1 FOR UPDATE`, firstEndpoint)
			}
			if err != nil {
				t.Fatal(err)
			}
			collector := &core.ConfigCollector{}
			n, err := collector.Pass(ctx, passedConfigBarrier{s}, 2)
			if err != nil || n != 1 {
				t.Fatalf("skip busy %s: %d %v", lockKind, n, err)
			}
			var first, second bool
			if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000001'),EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000002')`).Scan(&first, &second); err != nil || !first || second {
				t.Fatalf("first=%v second=%v err=%v", first, second, err)
			}
		})
	}
}
