package webhook_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type retentionReply struct {
	status int
	body   string
	err    error
}
type gatedHistoryStore struct {
	store.WebhookTransactions
	entered chan struct{}
	resume  chan struct{}
}

func (g *gatedHistoryStore) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	return g.WebhookTransactions.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		if _, err := sc.ObservedAt(ctx); err != nil {
			return err
		}
		close(g.entered)
		select {
		case <-g.resume:
		case <-ctx.Done():
			return ctx.Err()
		}
		return fn(sc)
	})
}

type retentionHTTP struct {
	f                         *captureFixture
	svc                       *webhook.Service
	host                      *httptest.Server
	token, endpoint, delivery string
}

func newRetentionHTTP(t *testing.T, expired bool) *retentionHTTP {
	t.Helper()
	f := newCaptureFixture(t, 1)
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "retention race"}); err != nil {
		t.Fatal(err)
	}
	var endpoint, delivery string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text FROM webhook_deliveries`).Scan(&endpoint, &delivery); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=now() WHERE id=$1`, delivery); err != nil {
		t.Fatal(err)
	}
	if expired {
		tx, err := f.db.Pool.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		if _, err = tx.Exec(f.ctx, `UPDATE webhook_events SET occurred_at=occurred_at-interval '31 days' WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, delivery); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-interval '31 days', automatic_schedule_at=ARRAY(SELECT x-interval '31 days' FROM unnest(automatic_schedule_at) x), automatic_expires_at=automatic_expires_at-interval '31 days',payload_expires_at=payload_expires_at-interval '31 days',expires_at=expires_at-interval '31 days',last_activity_at=occurred_at-interval '31 days',metadata_expires_at=occurred_at-interval '1 day' WHERE id=$1`, delivery); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	host := httptest.NewServer(mux)
	t.Cleanup(host.Close)
	return &retentionHTTP{f: f, svc: svc, host: host, token: token, endpoint: endpoint, delivery: delivery}
}
func (r *retentionHTTP) call(method, suffix, body string) <-chan retentionReply {
	ch := make(chan retentionReply, 1)
	go func() {
		req, err := http.NewRequestWithContext(r.f.ctx, method, r.host.URL+"/api/v1/me/webhooks/"+r.endpoint+"/deliveries/"+r.delivery+suffix, strings.NewReader(body))
		if err != nil {
			ch <- retentionReply{err: err}
			return
		}
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: r.token})
		req.Header.Set("Origin", "https://daynight.example")
		req.Header.Set("Content-Type", "application/json")
		res, err := r.host.Client().Do(req)
		if err != nil {
			ch <- retentionReply{err: err}
			return
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err == nil && (res.Header.Get("Daynight-User-ID") != r.f.principal.UserID || res.Header.Get("Cache-Control") != "no-store") {
			err = fmt.Errorf("invalid auth headers")
		}
		ch <- retentionReply{res.StatusCode, string(b), err}
	}()
	return ch
}
func (r *retentionHTTP) intent() string {
	return fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","ifGeneration":"1"}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), r.f.principal.UserID)
}
func retentionWait(t *testing.T, r *retentionHTTP, blocker int32) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var waiting bool
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-timer.C:
			t.Fatal("expected PostgreSQL lock wait was not observed")
		case <-r.f.ctx.Done():
			t.Fatal(r.f.ctx.Err())
		case <-tick.C:
		}
	}
}
func retentionReceive(t *testing.T, r *retentionHTTP, ch <-chan retentionReply, want int) {
	t.Helper()
	select {
	case x := <-ch:
		if x.err != nil || x.status != want {
			t.Fatalf("HTTP status=%d body=%s err=%v want=%d", x.status, x.body, x.err, want)
		}
	case <-r.f.ctx.Done():
		t.Fatal(r.f.ctx.Err())
	}
}
func retentionCounts(t *testing.T, r *retentionHTTP, wantManual, wantReceipts int, wantGen int64) {
	t.Helper()
	var manual, receipts, attempts int
	var gen int64
	var body []byte
	var purging *time.Time
	err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT manual_operation_count,generation,body,purging_at,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&manual, &gen, &body, &purging, &receipts, &attempts)
	if err != nil || manual != wantManual || gen != wantGen || receipts != wantReceipts || attempts != 0 || len(body) == 0 {
		t.Fatalf("counts manual=%d gen=%d receipts=%d attempts=%d body=%d purging=%v err=%v", manual, gen, receipts, attempts, len(body), purging, err)
	}
}

// The close transaction is a controlled retention-state fixture, not the T06 GC.
func TestRedeliveryHTTPRetentionLockOrdering(t *testing.T) {
	t.Run("close first, valid intent", func(t *testing.T) {
		r := newRetentionHTTP(t, false)
		tx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		var pid int32
		if err = tx.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(r.f.ctx, `SELECT id FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, r.delivery); err != nil {
			t.Fatal(err)
		}
		result := r.call("POST", "/redeliveries", r.intent())
		retentionWait(t, r, pid)
		tag, err := tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1 AND metadata_expires_at<=clock_timestamp() AND state<>'leased' AND NOT (state='pending' AND expires_at>clock_timestamp())`, r.delivery)
		if err != nil || tag.RowsAffected() != 0 {
			t.Fatalf("valid record closed: %v %v", tag, err)
		}
		if err = tx.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, result, 202)
		retentionCounts(t, r, 1, 1, 2)
	})
	t.Run("intent first, valid record retained", func(t *testing.T) {
		r := newRetentionHTTP(t, false)
		blocker, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer blocker.Rollback(context.Background())
		if _, err = blocker.Exec(r.f.ctx, `SELECT pg_advisory_xact_lock(7205101)`); err != nil {
			t.Fatal(err)
		}
		if _, err = r.f.db.Pool.Exec(r.f.ctx, `CREATE FUNCTION hold_manual_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trigger='manual' THEN PERFORM pg_advisory_xact_lock(7205101); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_manual_test BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION hold_manual_test()`); err != nil {
			t.Fatal(err)
		}
		var pid int32
		if err = blocker.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		result := r.call("POST", "/redeliveries", r.intent())
		retentionWait(t, r, pid)
		done := make(chan error, 1)
		go func() {
			tx, e := r.f.db.Pool.Begin(r.f.ctx)
			if e != nil {
				done <- e
				return
			}
			defer tx.Rollback(context.Background())
			var n int32
			if e = tx.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&n); e != nil {
				done <- e
				return
			}
			tag, e := tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1 AND metadata_expires_at<=clock_timestamp() AND state<>'leased' AND NOT (state='pending' AND expires_at>clock_timestamp())`, r.delivery)
			if e == nil && tag.RowsAffected() != 0 {
				e = fmt.Errorf("closed active manual intent")
			}
			if e == nil {
				e = tx.Commit(r.f.ctx)
			}
			done <- e
		}()
		// The UPDATE's WHERE can avoid taking a lock on an unexpired row. Explicitly
		// lock the row from a second transaction to prove the ordering.
		lockDone := make(chan error, 1)
		go func() {
			tx, e := r.f.db.Pool.Begin(r.f.ctx)
			if e != nil {
				lockDone <- e
				return
			}
			defer tx.Rollback(context.Background())
			_, e = tx.Exec(r.f.ctx, `SELECT id FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, r.delivery)
			if e == nil {
				e = tx.Commit(r.f.ctx)
			}
			lockDone <- e
		}()
		var writer int32
		if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1`, pid).Scan(&writer); err != nil {
			t.Fatal(err)
		}
		retentionWait(t, r, writer)
		if err = blocker.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, result, 202)
		if err = <-done; err != nil {
			t.Fatal(err)
		}
		if err = <-lockDone; err != nil {
			t.Fatal(err)
		}
		retentionCounts(t, r, 1, 1, 2)
	})
	t.Run("expired, before and after close", func(t *testing.T) {
		r := newRetentionHTTP(t, true)
		retentionReceive(t, r, r.call("POST", "/redeliveries", r.intent()), 410)
		retentionCounts(t, r, 0, 0, 1)
		tx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		var pid int32
		if err = tx.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		tag, err := tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1 AND metadata_expires_at<=clock_timestamp() AND state<>'leased' AND NOT (state='pending' AND expires_at>clock_timestamp())`, r.delivery)
		if err != nil || tag.RowsAffected() != 1 {
			t.Fatalf("controlled close: %v %v", tag, err)
		}
		result := r.call("POST", "/redeliveries", r.intent())
		retentionWait(t, r, pid)
		if err = tx.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, result, 404)
		retentionCounts(t, r, 0, 0, 1)
	})
}

var _ store.WebhookTransactions = (*gatedHistoryStore)(nil)

func shiftRetentionOccurrence(t *testing.T, r *retentionHTTP, shift string) {
	t.Helper()
	tx, err := r.f.db.Pool.Begin(r.f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(r.f.ctx, `UPDATE webhook_events SET occurred_at=occurred_at-$2::interval WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, r.delivery, shift); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-$2::interval,automatic_schedule_at=ARRAY(SELECT x-$2::interval FROM unnest(automatic_schedule_at) x),automatic_expires_at=automatic_expires_at-$2::interval,payload_expires_at=payload_expires_at-$2::interval,expires_at=expires_at-$2::interval,last_activity_at=occurred_at-$2::interval,metadata_expires_at=occurred_at-$2::interval+interval '30 days' WHERE id=$1`, r.delivery, shift); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(r.f.ctx); err != nil {
		t.Fatal(err)
	}
}
func waitRetentionDeadline(t *testing.T, r *retentionHTTP, column string) {
	t.Helper()
	if column != "payload_expires_at" && column != "metadata_expires_at" {
		t.Fatal("invalid deadline")
	}
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		var elapsed bool
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT `+column+`<=clock_timestamp() FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&elapsed); err != nil {
			t.Fatal(err)
		}
		if elapsed {
			return
		}
		select {
		case <-timer.C:
			t.Fatal("deadline did not pass")
		case <-r.f.ctx.Done():
			t.Fatal(r.f.ctx.Err())
		case <-tick.C:
		}
	}
}

func TestRedeliveryHTTPRetentionSnapshotAndLease(t *testing.T) {
	t.Run("snapshot spans controlled close", func(t *testing.T) {
		r := newRetentionHTTP(t, false)
		shiftRetentionOccurrence(t, r, "29 days 23 hours 59 minutes 55 seconds")
		original := r.svc.DB
		gate := &gatedHistoryStore{WebhookTransactions: original, entered: make(chan struct{}), resume: make(chan struct{})}
		r.svc.DB = gate
		old := r.call("GET", "", "")
		select {
		case <-gate.entered:
		case <-r.f.ctx.Done():
			t.Fatal(r.f.ctx.Err())
		}
		r.svc.DB = original
		waitRetentionDeadline(t, r, "metadata_expires_at")
		tx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		tag, err := tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1 AND metadata_expires_at<=clock_timestamp() AND state<>'leased' AND NOT (state='pending' AND expires_at>clock_timestamp())`, r.delivery)
		if err != nil || tag.RowsAffected() != 1 {
			close(gate.resume)
			t.Fatalf("controlled close: %v %v", tag, err)
		}
		if _, err = tx.Exec(r.f.ctx, `DELETE FROM webhook_delivery_matches WHERE delivery_id=$1`, r.delivery); err != nil {
			close(gate.resume)
			t.Fatal(err)
		}
		if err = tx.Commit(r.f.ctx); err != nil {
			close(gate.resume)
			t.Fatal(err)
		}
		close(gate.resume)
		retentionReceive(t, r, old, 200)
		retentionReceive(t, r, r.call("GET", "", ""), 404)
	})
	t.Run("admitted lease retains payload past deadline", func(t *testing.T) {
		r := newRetentionHTTP(t, false)
		shiftRetentionOccurrence(t, r, "6 days 23 hours 59 minutes 55 seconds")
		attempt := uuid.NewString()
		tx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		if _, err = tx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds',lease_generation=generation,lease_plan_slot=1,current_attempt_id=$2,attempt_sequence=1,automatic_attempt_count=1 WHERE id=$1`, r.delivery, attempt); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(r.f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at) SELECT $2::uuid,d.id,d.endpoint_id,d.generation,1,'automatic',d.lease_token,d.destination_revision,ARRAY[e.active_key_id],1,d.lease_claimed_at,d.lease_claimed_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, r.delivery, attempt); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		waitRetentionDeadline(t, r, "payload_expires_at")
		closeTx, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer closeTx.Rollback(context.Background())
		if _, err = closeTx.Exec(r.f.ctx, `SELECT id FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, r.delivery); err != nil {
			t.Fatal(err)
		}
		tag, err := closeTx.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=clock_timestamp(),payload_removed_reason='expired' WHERE id=$1 AND payload_expires_at<=clock_timestamp() AND NOT (state='leased' AND lease_until>clock_timestamp()) AND NOT (state='pending' AND trigger='manual' AND expires_at>clock_timestamp())`, r.delivery)
		if err != nil || tag.RowsAffected() != 0 {
			t.Fatalf("active lease payload cleared: %v %v", tag, err)
		}
		if err = closeTx.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, r.call("GET", "/payload", ""), 410)
		retentionReceive(t, r, r.call("POST", "/redeliveries", r.intent()), 410)
		var present, live bool
		var count, manual int
		if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT body IS NOT NULL,lease_until>clock_timestamp(),attempt_sequence,manual_operation_count FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&present, &live, &count, &manual); err != nil || !present || !live || count != 1 || manual != 0 {
			t.Fatalf("lease state present=%t live=%t attempts=%d manual=%d err=%v", present, live, count, manual, err)
		}
	})
}
