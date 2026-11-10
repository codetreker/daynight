package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func configGCTransactionCleanup(t *testing.T, tx pgx.Tx) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Errorf("rollback configuration GC transaction: %v", err)
		}
	})
}

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
	want := store.WebhookConfigGCCandidate{Order: 1, Kind: "key", ID: old.ID, EndpointID: ep.ID, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}}
	scan, err := s.ScanWebhookConfigGC(ctx, nil, 1)
	if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, []store.WebhookConfigGCCandidate{want}) {
		t.Fatalf("overlap key scan: %+v %v", scan, err)
	}
	removed := false
	completion, err = s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
		if err != nil {
			return err
		}
		if !facts.Present || !facts.Retired || facts.Referenced || !facts.Expiry.Equal(expired.Truncate(time.Microsecond)) || !facts.ObservedAt.After(facts.Expiry) {
			return fmt.Errorf("locked expired key facts: %+v", facts)
		}
		removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[0])
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
		t.Fatalf("expired key deletion: removed=%v completion=%+v err=%v", removed, completion, err)
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
	configGCTransactionCleanup(t, tx)
	if _, err = tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
		t.Fatal(err)
	}
	want := store.WebhookConfigGCCandidate{Order: 2, Kind: "binding", ID: binding.ID, EndpointID: ep.ID, ProjectID: sub.ProjectID, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}}
	scan, err := s.ScanWebhookConfigGC(ctx, nil, 1)
	if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, []store.WebhookConfigGCCandidate{want}) {
		t.Fatalf("retired binding scan: %+v %v", scan, err)
	}
	passed, err := s.WebhookConfigGCBarrierPassed(ctx, scan.Barrier)
	if err != nil || passed {
		t.Fatalf("barrier passed while the earlier transaction remained active: %v %v", passed, err)
	}
	var present bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || !present {
		t.Fatalf("retired binding: %v %v", present, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Other packages may retain older XIDs; this write proves the locked
	// recheck. The prepared-transaction stress test owns global convergence.
	removed := false
	completion, err := s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
		if err != nil {
			return err
		}
		if !facts.Present || !facts.Retired || facts.Referenced {
			return fmt.Errorf("locked retired binding facts: %+v", facts)
		}
		removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[0])
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
		t.Fatalf("retired binding deletion: removed=%v completion=%+v err=%v", removed, completion, err)
	}
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || present {
		t.Fatalf("retired binding was not reclaimed: present=%v err=%v", present, err)
	}
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
			var candidates []store.WebhookConfigGCCandidate
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
				candidates = append(candidates, store.WebhookConfigGCCandidate{Order: 2, Kind: "binding", ID: binding.ID, EndpointID: ep.ID, ProjectID: project, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}})
			}
			scan, err := s.ScanWebhookConfigGC(ctx, nil, 2)
			if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, candidates) {
				t.Fatalf("ordered binding scan: %+v %v", scan, err)
			}
			lock, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			configGCTransactionCleanup(t, lock)
			if lockKind == "project" {
				_, err = lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, candidates[0].ProjectID)
			} else {
				_, err = lock.Exec(ctx, `SELECT id FROM webhook_endpoints WHERE id=$1 FOR UPDATE`, candidates[0].EndpointID)
			}
			if err != nil {
				t.Fatal(err)
			}
			called := false
			completion, err := s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
				called = true
				_, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
				return err
			})
			var cause *pgconn.PgError
			if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "55P03" || called != (lockKind == "endpoint") {
				t.Fatalf("busy %s completion=%+v callback=%v err=%v", lockKind, completion, called, err)
			}
			removed := false
			completion, err = s.WriteWebhookConfigGC(ctx, scan.Candidates[1], func(sc store.WebhookConfigGCScope) error {
				facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[1])
				if err != nil {
					return err
				}
				if !facts.Present || !facts.Retired || facts.Referenced {
					return fmt.Errorf("locked second binding facts: %+v", facts)
				}
				removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[1])
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
				t.Fatalf("second binding deletion: removed=%v completion=%+v err=%v", removed, completion, err)
			}
			var first, second bool
			if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000001'),EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000002')`).Scan(&first, &second); err != nil || !first || second {
				t.Fatalf("first=%v second=%v err=%v", first, second, err)
			}
		})
	}
}
