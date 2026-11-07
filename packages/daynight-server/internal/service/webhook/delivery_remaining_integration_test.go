package webhook_test

import (
	"context"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func remainingCaptured(t *testing.T, f *captureFixture, n int) []string {
	t.Helper()
	tasks := taskservice.NewTasks(f.db, f.capture)
	for i := 0; i < n; i++ {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: fmt.Sprintf("remaining %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT id::text FROM webhook_deliveries ORDER BY queue_order,id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) != n {
		t.Fatalf("deliveries %v", ids)
	}
	return ids
}
func remainingReceiver(t *testing.T, f *captureFixture, handler http.Handler) (*webhook.Service, *httpoutbound.Client) {
	t.Helper()
	receiver := httptest.NewTLSServer(handler)
	t.Cleanup(receiver.Close)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}})
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	return svc, httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
}
func remainingRunner(t *testing.T, f *captureFixture, svc *webhook.Service, c *httpoutbound.Client) *webhook.Runner {
	t.Helper()
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(c)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return runner
}
func remainingWait(t *testing.T, f *captureFixture, r *webhook.Runner, predicate func() bool) {
	t.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if predicate() {
			return
		}
		select {
		case err := <-r.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-deadline.C:
			t.Fatal("delivery state did not converge")
		case <-ticker.C:
		}
	}
}

func TestDeliveryClaimMultipleInstancesExcludeFutureAndPurging(t *testing.T) {
	f := newCaptureFixture(t, 1)
	ids := remainingCaptured(t, f, 4)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, ids[1]); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, f.db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	second := &postgres.Store{Pool: pool}
	type result struct {
		rows    []store.WebhookDelivery
		token   string
		outcome store.Completion
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for _, db := range []*postgres.Store{f.db, second} {
		wg.Add(1)
		go func(db *postgres.Store) {
			defer wg.Done()
			<-start
			token := uuid.NewString()
			var rows []store.WebhookDelivery
			completion, err := db.WriteWebhookDelivery(f.ctx, func(scope store.WebhookDeliveryScope) error {
				now, e := scope.ObservedAt(f.ctx)
				if e != nil {
					return e
				}
				rows, e = scope.Claim(f.ctx, 1, now, []string{token})
				return e
			})
			results <- result{rows, token, completion, err}
		}(db)
	}
	close(start)
	wg.Wait()
	close(results)
	seen := map[string]bool{}
	for r := range results {
		if r.err != nil || r.outcome.Outcome != store.TransactionCommitted || len(r.rows) != 1 {
			t.Fatalf("instance claim: %+v", r)
		}
		row := r.rows[0]
		if row.ID != ids[2] && row.ID != ids[3] {
			t.Fatalf("claimed excluded delivery %s", row.ID)
		}
		if seen[row.ID] || row.LeaseToken == nil || *row.LeaseToken != r.token {
			t.Fatalf("duplicate or incorrect token %+v", row)
		}
		seen[row.ID] = true
		var token, state string
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT lease_token::text,state FROM webhook_deliveries WHERE id=$1`, row.ID).Scan(&token, &state); err != nil || token != r.token || state != "leased" {
			t.Fatalf("stored claim %s %s %v", token, state, err)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("claimed set %v", seen)
	}
}

func TestDeliveryRealFailureRequeuesBehindOlderTicket(t *testing.T) {
	f := newCaptureFixture(t, 1)
	requests := make(chan string, 2)
	svc, client := remainingReceiver(t, f, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Get("Webhook-Id")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	ids := remainingCaptured(t, f, 2)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET automatic_schedule_at[2]=occurred_at+interval '1 second' WHERE id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, ids[1]); err != nil {
		t.Fatal(err)
	}
	var firstTicket, secondTicket int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT queue_order FROM webhook_deliveries WHERE id=$1),(SELECT queue_order FROM webhook_deliveries WHERE id=$2)`, ids[0], ids[1]).Scan(&firstTicket, &secondTicket); err != nil {
		t.Fatal(err)
	}
	runner := remainingRunner(t, f, svc, client)
	select {
	case <-requests:
	case e := <-runner.Failures():
		t.Fatal(e)
	case <-time.After(5 * time.Second):
		t.Fatal("first receiver request missing")
	}
	var retryTicket int64
	var next time.Time
	remainingWait(t, f, runner, func() bool {
		var state string
		var count int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT state,queue_order,next_attempt_at,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1 AND outcome='http_error') FROM webhook_deliveries WHERE id=$1`, ids[0]).Scan(&state, &retryTicket, &next, &count)
		if err != nil {
			t.Fatal(err)
		}
		return state == "pending" && count == 1
	})
	if retryTicket <= secondTicket || secondTicket <= firstTicket {
		t.Fatalf("ticket sequence first=%d other=%d retry=%d", firstTicket, secondTicket, retryTicket)
	}
	stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := runner.Stop(stop); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET next_attempt_at=clock_timestamp() WHERE id=$1`, ids[1]); err != nil {
		t.Fatal(err)
	}
	for {
		var due bool
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT next_attempt_at<=clock_timestamp() FROM webhook_deliveries WHERE id=$1`, ids[0]).Scan(&due); err != nil {
			t.Fatal(err)
		}
		if due {
			break
		}
		select {
		case <-f.ctx.Done():
			t.Fatal("retry did not become due")
		case <-time.After(20 * time.Millisecond):
		}
	}
	var claimed []store.WebhookDelivery
	completion, err := f.db.WriteWebhookDelivery(f.ctx, func(scope store.WebhookDeliveryScope) error {
		now, e := scope.ObservedAt(f.ctx)
		if e != nil {
			return e
		}
		claimed, e = scope.Claim(f.ctx, 1, now, []string{uuid.NewString()})
		return e
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || len(claimed) != 1 || claimed[0].ID != ids[1] {
		t.Fatalf("older due ticket did not win: rows=%+v outcome=%s err=%v", claimed, completion.Outcome, err)
	}
}

// ageRemaining shifts the captured event and its persisted plan together. This
// simulates elapsed wall time without changing the plan's offsets or deadline.
func ageRemaining(t *testing.T, f *captureFixture, id string, age time.Duration) {
	t.Helper()
	var occurred time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT clock_timestamp()-($1::bigint * interval '1 second')`, int64(age/time.Second)).Scan(&occurred); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(f.ctx, `UPDATE webhook_events SET occurred_at=$2 WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, id, occurred); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET occurred_at=$2,automatic_schedule_at=ARRAY[$2::timestamptz,$2::timestamptz+interval '1 minute',$2::timestamptz+interval '5 minutes',$2::timestamptz+interval '30 minutes',$2::timestamptz+interval '2 hours',$2::timestamptz+interval '6 hours',$2::timestamptz+interval '12 hours',$2::timestamptz+interval '24 hours',$2::timestamptz+interval '48 hours',$2::timestamptz+interval '71 hours'],automatic_expires_at=$2::timestamptz+interval '72 hours',payload_expires_at=$2::timestamptz+interval '168 hours',expires_at=$2::timestamptz+interval '72 hours',next_attempt_at=$2 WHERE id=$1`, id, occurred); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestDeliveryOriginalBudgetAndBacklogWithReceiver(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var count atomic.Int32
	received := make(chan string, 8)
	svc, client := remainingReceiver(t, f, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		received <- r.Header.Get("Webhook-Id")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	ids := remainingCaptured(t, f, 3)
	// Ten historic admissions are seeded in the real database to test a retained
	// exhausted budget without pretending that ten network calls occurred here.
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at,finished_at,outcome,http_status,duration_ms) SELECT gen_random_uuid(),d.id,d.endpoint_id,d.generation,n,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],n,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '30 seconds','http_error',500,1 FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id CROSS JOIN generate_series(1,10) n WHERE d.id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET automatic_attempt_count=10,attempt_sequence=10,automatic_plan_cursor=10 WHERE id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	ageRemaining(t, f, ids[1], 73*time.Hour)
	ageRemaining(t, f, ids[2], 2*time.Hour+5*time.Second)
	var backlogEvent string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT event_id::text FROM webhook_deliveries WHERE id=$1`, ids[2]).Scan(&backlogEvent); err != nil {
		t.Fatal(err)
	}
	runner := remainingRunner(t, f, svc, client)
	select {
	case id := <-received:
		if id != backlogEvent {
			t.Fatalf("unexpected receiver event %s", id)
		}
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("backlog request missing")
	}
	remainingWait(t, f, runner, func() bool {
		var state0, state1, state2 string
		var c0, c1, c2, automatic int
		var cursor int16
		err := f.db.Pool.QueryRow(f.ctx, `SELECT d0.state,d1.state,d2.state,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d0.id),(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d1.id),(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d2.id),d2.automatic_attempt_count,d2.automatic_plan_cursor FROM webhook_deliveries d0 CROSS JOIN webhook_deliveries d1 CROSS JOIN webhook_deliveries d2 WHERE d0.id=$1 AND d1.id=$2 AND d2.id=$3`, ids[0], ids[1], ids[2]).Scan(&state0, &state1, &state2, &c0, &c1, &c2, &automatic, &cursor)
		if err != nil {
			t.Fatal(err)
		}
		return state0 == "failed" && state1 == "failed" && state2 == "pending" && c0 == 10 && c1 == 0 && c2 == 1 && automatic == 1 && cursor == 5
	})
	select {
	case id := <-received:
		t.Fatalf("unexpected extra receiver request %s", id)
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(1500 * time.Millisecond):
	}
	if got := count.Load(); got != 1 {
		t.Fatalf("receiver count %d", got)
	}
}
