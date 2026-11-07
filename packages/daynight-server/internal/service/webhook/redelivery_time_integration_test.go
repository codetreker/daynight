package webhook_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

type redeliveryClockGate struct {
	store.WebhookTransactions
	once             sync.Once
	entered, release chan struct{}
}
type gatedRedeliveryScope struct {
	store.WebhookWriteScope
	gate *redeliveryClockGate
}
type gatedRedeliveryEligibility struct {
	store.WebhookEligibilityDAO
	gate *redeliveryClockGate
}

func (g *redeliveryClockGate) WriteWebhook(ctx context.Context, o wm.Owner, id string, work func(store.WebhookWriteScope) error) (store.Completion, error) {
	return g.WebhookTransactions.WriteWebhook(ctx, o, id, func(sc store.WebhookWriteScope) error { return work(gatedRedeliveryScope{sc, g}) })
}
func (s gatedRedeliveryScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return gatedRedeliveryEligibility{s.WebhookWriteScope.EligibilityDAO(), s.gate}
}
func (e gatedRedeliveryEligibility) ReadEligibility(ctx context.Context, o wm.Owner, project, actor string) (store.WebhookEligibility, error) {
	var waitErr error
	e.gate.once.Do(func() {
		close(e.gate.entered)
		select {
		case <-e.gate.release:
		case <-ctx.Done():
			waitErr = ctx.Err()
		}
	})
	if waitErr != nil {
		return store.WebhookEligibility{}, waitErr
	}
	return e.WebhookEligibilityDAO.ReadEligibility(ctx, o, project, actor)
}

func TestRedeliveryRechecksDeadlinesAfterReadWait(t *testing.T) {
	for _, kind := range []string{"payload", "operation", "credential"} {
		t.Run(kind, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			f := r.f
			deadline := time.Now().UTC().Add(2 * time.Second)
			issued := time.Now().UTC()
			switch kind {
			case "payload":
				occurred := deadline.Add(-168 * time.Hour)
				tx, err := f.db.Pool.Begin(f.ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err = tx.Exec(f.ctx, `UPDATE webhook_events SET occurred_at=$2 WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery, occurred); err != nil {
					t.Fatal(err)
				}
				if _, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET automatic_schedule_at=ARRAY(SELECT x+($2::timestamptz-occurred_at) FROM unnest(automatic_schedule_at) x),occurred_at=$2,automatic_expires_at=$2::timestamptz+interval '72 hours',payload_expires_at=$2::timestamptz+interval '168 hours',expires_at=$2::timestamptz+interval '72 hours' WHERE id=$1`, r.delivery, occurred); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(f.ctx); err != nil {
					t.Fatal(err)
				}
			case "operation":
				issued = deadline.Add(-5 * time.Minute)
			case "credential":
				if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET expires_at=$2 WHERE id=$1`, f.principal.CredentialID, deadline); err != nil {
					t.Fatal(err)
				}
			}
			gate := &redeliveryClockGate{WebhookTransactions: f.db, entered: make(chan struct{}), release: make(chan struct{})}
			svc := &webhook.Service{DB: gate, Keys: f.capture.Keys, DispatchEnabled: true}
			var originalTicket int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&originalTicket); err != nil {
				t.Fatal(err)
			}
			input := webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: issued.Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("a", 64)}
			result := make(chan error, 1)
			go func() {
				_, err := svc.Redeliver(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, r.endpoint, r.delivery, input)
				result <- err
			}()
			select {
			case <-gate.entered:
			case err := <-result:
				t.Fatalf("request failed before gate: %v", err)
			case <-time.After(5 * time.Second):
				t.Fatal("eligibility gate not reached")
			}
			timer := time.NewTimer(time.Until(deadline) + 100*time.Millisecond)
			select {
			case <-timer.C:
			case <-f.ctx.Done():
				timer.Stop()
				t.Fatal(f.ctx.Err())
			}
			close(gate.release)
			var err error
			select {
			case err = <-result:
			case <-time.After(5 * time.Second):
				t.Fatal("request did not finish")
			}
			var fault *model.Fault
			if !errors.As(err, &fault) {
				t.Fatalf("deadline error: %v", err)
			}
			want := map[string]string{"payload": "payload_expired", "operation": "operation_expired", "credential": "unauthenticated"}[kind]
			if fault.Code != want {
				t.Fatalf("deadline fault=%s want=%s: %v", fault.Code, want, err)
			}
			var generation, ticket int64
			var manual, receipts, attempts int
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT generation,manual_operation_count,queue_order,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&generation, &manual, &ticket, &receipts, &attempts); err != nil || generation != 1 || manual != 0 || ticket != originalTicket || receipts != 0 || attempts != 0 {
				t.Fatalf("deadline left effects: generation=%d manual=%d ticket=%d receipts=%d attempts=%d err=%v", generation, manual, ticket, receipts, attempts, err)
			}
		})
	}
}

func TestRedeliveryMissingEventIsCorruptionUnlessReclaimed(t *testing.T) {
	r := newRetentionHTTP(t, false)
	missing := *r
	missing.delivery = uuid.NewString()
	retentionReceive(t, r, missing.call(http.MethodPost, "/redeliveries", missing.intent()), http.StatusNotFound)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM webhook_events WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusInternalServerError)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusNotFound)
	var count int
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'`).Scan(&count); err != nil || count != 0 {
		t.Fatal(fmt.Errorf("unexpected receipts=%d: %w", count, err))
	}
}

func TestRedeliveryPrematurePayloadRemovalIsCorruption(t *testing.T) {
	r := newRetentionHTTP(t, false)
	var ticket int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&ticket); err != nil {
		t.Fatal(err)
	}
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=clock_timestamp(),payload_removed_reason='expired' WHERE id=$1 AND payload_expires_at>clock_timestamp()`, r.delivery); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-r.call(http.MethodPost, "/redeliveries", r.intent()):
		if reply.err != nil || reply.status != http.StatusInternalServerError || !strings.Contains(reply.body, `"code":"internal_error"`) {
			t.Fatalf("premature removal: status=%d body=%s err=%v", reply.status, reply.body, reply.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("redelivery did not finish")
	}
	var generation, afterTicket int64
	var manual, receipts, attempts int
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT generation,manual_operation_count,queue_order,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&generation, &manual, &afterTicket, &receipts, &attempts); err != nil || generation != 1 || manual != 0 || ticket != afterTicket || receipts != 0 || attempts != 0 {
		t.Fatalf("premature removal left effects: generation=%d manual=%d ticket=%d receipts=%d attempts=%d err=%v", generation, manual, afterTicket, receipts, attempts, err)
	}
}

func TestRedeliveryMissingProofIsInternalError(t *testing.T) {
	r := newRetentionHTTP(t, false)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM webhook_delivery_matches WHERE delivery_id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-r.call(http.MethodPost, "/redeliveries", r.intent()):
		if reply.err != nil || reply.status != http.StatusInternalServerError || !strings.Contains(reply.body, `"code":"internal_error"`) {
			t.Fatalf("missing proof: status=%d body=%s err=%v", reply.status, reply.body, reply.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("redelivery did not finish")
	}
	var generation int64
	var manual, receipts int
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT generation,manual_operation_count,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&generation, &manual, &receipts); err != nil || generation != 1 || manual != 0 || receipts != 0 {
		t.Fatalf("missing proof left effects: generation=%d manual=%d receipts=%d err=%v", generation, manual, receipts, err)
	}
}

func TestRedeliveryMissingEventReauthorizesAfterLockWait(t *testing.T) {
	for _, kind := range []string{"credential", "team membership"} {
		t.Run(kind, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			path := "/api/v1/me/webhooks/" + r.endpoint + "/deliveries/" + r.delivery + "/redeliveries"
			var team string
			if kind == "team membership" {
				if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, r.f.project).Scan(&team); err != nil {
					t.Fatal(err)
				}
				name, enabled := "team webhook", true
				result, err := r.svc.Mutate(r.f.ctx, r.f.principal, webhook.Owner{Kind: "team", ID: team}, webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: r.f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: r.f.project, EventTypes: []string{"task.created"}}}})
				if err != nil {
					t.Fatal(err)
				}
				r.endpoint = result.Body.(map[string]any)["endpoint"].(map[string]any)["id"].(string)
				if _, err = taskservice.NewTasks(r.f.db, r.f.capture).Create(r.f.ctx, r.f.principal, r.f.project, taskcore.CreateTask{Title: "team source"}); err != nil {
					t.Fatal(err)
				}
				if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT id::text FROM webhook_deliveries WHERE endpoint_id=$1`, r.endpoint).Scan(&r.delivery); err != nil {
					t.Fatal(err)
				}
				path = "/api/v1/teams/" + team + "/webhooks/" + r.endpoint + "/deliveries/" + r.delivery + "/redeliveries"
			}
			if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM webhook_events WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery); err != nil {
				t.Fatal(err)
			}
			lock, err := r.f.db.Pool.Begin(r.f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			var blocker int32
			if err = lock.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			if _, err = lock.Exec(r.f.ctx, `SELECT id FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, r.delivery); err != nil {
				t.Fatal(err)
			}
			reply := make(chan retentionReply, 1)
			go func() {
				req, e := http.NewRequestWithContext(r.f.ctx, http.MethodPost, r.host.URL+path, strings.NewReader(r.intent()))
				if e != nil {
					reply <- retentionReply{err: e}
					return
				}
				req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: r.token})
				req.Header.Set("Origin", "https://daynight.example")
				req.Header.Set("Content-Type", "application/json")
				res, e := r.host.Client().Do(req)
				if e != nil {
					reply <- retentionReply{err: e}
					return
				}
				defer res.Body.Close()
				b, e := io.ReadAll(res.Body)
				reply <- retentionReply{status: res.StatusCode, body: string(b), err: e}
			}()
			retentionWait(t, r, blocker)
			want := http.StatusUnauthorized
			if kind == "credential" {
				_, err = r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM sessions WHERE id=$1`, r.f.principal.CredentialID)
			} else {
				want = http.StatusForbidden
				_, err = r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, r.f.principal.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = lock.Commit(r.f.ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-reply:
				if got.err != nil || got.status != want {
					t.Fatalf("revocation status=%d body=%s err=%v want=%d", got.status, got.body, got.err, want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("request did not finish")
			}
			var receipts int
			if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'`).Scan(&receipts); err != nil || receipts != 0 {
				t.Fatalf("unexpected receipts=%d err=%v", receipts, err)
			}
		})
	}
}

func TestRedeliveryMissingEventAfterLogicalExpiry(t *testing.T) {
	t.Run("payload expired, metadata retained", func(t *testing.T) {
		r := newRetentionHTTP(t, false)
		tx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		if _, err = tx.Exec(r.f.ctx, `UPDATE webhook_events SET occurred_at=occurred_at-interval '8 days' WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-interval '8 days',automatic_schedule_at=ARRAY(SELECT x-interval '8 days' FROM unnest(automatic_schedule_at) x),automatic_expires_at=automatic_expires_at-interval '8 days',payload_expires_at=payload_expires_at-interval '8 days',expires_at=expires_at-interval '8 days' WHERE id=$1`, r.delivery); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(r.f.ctx, `DELETE FROM webhook_events WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusGone)
	})
	t.Run("metadata expired, later observation, purging", func(t *testing.T) {
		r := newRetentionHTTP(t, true)
		if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM webhook_events WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusNotFound)
		if _, err := r.f.db.Pool.Exec(r.f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at,finished_at,outcome) SELECT gen_random_uuid(),d.id,d.endpoint_id,d.generation,1,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],1,now()-interval '31 days',now()-interval '31 days',now(),'acknowledged' FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, r.delivery); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusGone)
		if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, r.delivery); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusNotFound)
		var count int
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("expired history wrote %d receipts: %v", count, err)
		}
	})
}

func TestRedeliveryRetainedHistoryBeforePurging(t *testing.T) {
	r := newRetentionHTTP(t, true)
	// An existing Event cannot make logically expired metadata readable.
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusNotFound)
	// Exercise the activity predicate with controlled persisted lease state;
	// this is not a claim that the maintenance service ran.
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '30 seconds',lease_generation=generation WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusGone)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET state='failed',lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at,finished_at,outcome,recovered_unknown_at,late_observed_at,late_outcome) SELECT gen_random_uuid(),d.id,d.endpoint_id,d.generation,1,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],1,now()-interval '31 days',now()-interval '31 days',now()-interval '31 days','unknown',now()-interval '31 days',now(),'acknowledged' FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET attempt_sequence=1,automatic_attempt_count=1,automatic_plan_cursor=1 WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusGone)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call(http.MethodPost, "/redeliveries", r.intent()), http.StatusNotFound)
	var manual, receipts int
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT manual_operation_count,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&manual, &receipts); err != nil || manual != 0 || receipts != 0 {
		t.Fatalf("expired history wrote manual=%d receipts=%d: %v", manual, receipts, err)
	}
}
