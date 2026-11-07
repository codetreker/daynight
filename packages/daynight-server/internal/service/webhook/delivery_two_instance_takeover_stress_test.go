//go:build stress

package webhook_test

import (
	"context"
	"crypto/x509"
	"fmt"
	"io"
	"math/rand"
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

type simultaneousClaim struct {
	owner int
	row   store.WebhookDelivery
}
type gatedClaimStore struct {
	base    store.WebhookDeliveryTransactions
	owner   int
	first   atomic.Bool
	claims  chan<- simultaneousClaim
	release <-chan struct{}
}
type gatedClaimScope struct {
	store.WebhookDeliveryScope
	owner *gatedClaimStore
}

func (g *gatedClaimStore) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	return g.base.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		return fn(gatedClaimScope{WebhookDeliveryScope: sc, owner: g})
	})
}
func (s gatedClaimScope) Claim(ctx context.Context, n int, now time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	if s.owner.first.CompareAndSwap(false, true) {
		rows, err := s.WebhookDeliveryScope.Claim(ctx, n, now, tokens)
		if err != nil {
			return nil, err
		}
		if len(rows) != 1 {
			return nil, fmt.Errorf("expected one gated claim, got %d", len(rows))
		}
		select {
		case s.owner.claims <- simultaneousClaim{owner: s.owner.owner, row: rows[0]}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-s.owner.release:
			return rows, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	select {
	case <-s.owner.release:
		return s.WebhookDeliveryScope.Claim(ctx, n, now, tokens)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// The first transactions hold different rows concurrently via SKIP LOCKED.
// A draining claimant's old request remains in flight while a second instance
// recovers the expired lease and sends a new attempt; its result is fenced.
func TestDeliveryTwoInstanceTakeoverAndFencingStress(t *testing.T) {
	for _, stopBeforeTakeover := range []bool{false, true} {
		name := "late_fencing"
		if stopBeforeTakeover {
			name = "drain_exit_before_takeover"
		}
		t.Run(name, func(t *testing.T) { testTwoInstanceTakeover(t, stopBeforeTakeover) })
	}
}

func testTwoInstanceTakeover(t *testing.T, stopBeforeTakeover bool) {
	arrivals := make(chan string, 8)
	releaseOld := make(chan struct{})
	var once sync.Once
	var mu sync.Mutex
	oldEvent := ""
	oldCalls := 0
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		id := r.Header.Get("Webhook-Id")
		mu.Lock()
		isOld := id == oldEvent
		if isOld {
			oldCalls++
		}
		firstOld := isOld && oldCalls == 1
		mu.Unlock()
		arrivals <- id
		if firstOld {
			select {
			case <-releaseOld:
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	defer once.Do(func() { close(releaseOld) })
	f := newCaptureFixture(t, 1)
	// Keep both captured second opportunities near 63 seconds so a 58-second
	// source starts at slot 1 and recovery reaches slot 2 within the deadline.
	// Only this fixture uses the deterministic stream; the production policy
	// and capturer still generate and persist the complete jittered schedule.
	f.capture.Random = rand.New(rand.NewSource(25))
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION t07_historical_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at=statement_timestamp()-interval '58 seconds'; NEW.updated_at=NEW.created_at; RETURN NEW; END $$; CREATE TRIGGER t07_historical_source BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION t07_historical_source()`); err != nil {
		t.Fatal(err)
	}
	tasks := taskservice.NewTasks(f.db, f.capture)
	for i := 0; i < 2; i++ {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "two instance takeover"}); err != nil {
			t.Fatal(err)
		}
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, f.db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	other := &postgres.Store{Pool: pool}
	claims := make(chan simultaneousClaim, 2)
	releaseClaims := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseClaims) })
	g1 := &gatedClaimStore{base: f.db, owner: 1, claims: claims, release: releaseClaims}
	g2 := &gatedClaimStore{base: other, owner: 2, claims: claims, release: releaseClaims}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	makeRunner := func(db store.WebhookDeliveryTransactions) *webhook.Runner {
		r := webhook.NewRunner(db, svc, true)
		r.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
		return r
	}
	r1, r2 := makeRunner(g1), makeRunner(g2)
	stop := func(r *webhook.Runner) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.Stop(ctx); err != nil {
			t.Error(err)
		}
	}
	defer stop(r1)
	defer stop(r2)
	start := make(chan struct{})
	started := make(chan error, 2)
	for _, r := range []*webhook.Runner{r1, r2} {
		go func(r *webhook.Runner) { <-start; started <- r.Start(context.Background()) }(r)
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-started; err != nil {
			t.Fatal(err)
		}
	}
	var first, second simultaneousClaim
	for i := 0; i < 2; i++ {
		select {
		case c := <-claims:
			if c.owner == 1 {
				first = c
			} else {
				second = c
			}
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent claims did not reach locked barrier")
		}
	}
	if first.row.ID == "" || second.row.ID == "" || first.row.ID == second.row.ID || first.row.LeaseToken == nil || second.row.LeaseToken == nil || *first.row.LeaseToken == *second.row.LeaseToken {
		t.Fatalf("invalid claims %+v %+v", first, second)
	}
	for _, claim := range []simultaneousClaim{first, second} {
		if len(claim.row.AutomaticScheduleAt) != 10 {
			t.Fatalf("invalid captured schedule: %v", claim.row.AutomaticScheduleAt)
		}
		untilSecond := time.Until(claim.row.AutomaticScheduleAt[1])
		if untilSecond <= 0 || untilSecond > 12*time.Second {
			t.Fatalf("second opportunity must remain future and within the takeover deadline: %s", untilSecond)
		}
	}
	mu.Lock()
	oldEvent = first.row.EventID
	mu.Unlock()
	releaseOnce.Do(func() { close(releaseClaims) })
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case id := <-arrivals:
			seen[id] = true
		case e := <-r1.Failures():
			t.Fatal(e)
		case e := <-r2.Failures():
			t.Fatal(e)
		case <-time.After(5 * time.Second):
			t.Fatal("initial TLS requests missing")
		}
	}
	if !seen[first.row.EventID] || !seen[second.row.EventID] {
		t.Fatalf("initial receiver events %v", seen)
	}
	for _, claim := range []simultaneousClaim{first, second} {
		var cursor, attempts int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT automatic_plan_cursor,automatic_attempt_count FROM webhook_deliveries WHERE id=$1`, claim.row.ID).Scan(&cursor, &attempts); err != nil {
			t.Fatal(err)
		}
		if cursor != 1 || attempts != 1 {
			t.Fatalf("initial admission must consume only slot 1: cursor=%d attempts=%d", cursor, attempts)
		}
	}
	r1.StopClaims()
	var oldAttempt, oldToken string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT a.id::text,a.lease_token::text FROM webhook_attempts a WHERE a.delivery_id=$1`, first.row.ID).Scan(&oldAttempt, &oldToken); err != nil {
		t.Fatal(err)
	}
	if stopBeforeTakeover {
		// Normal shutdown cancels the unresolved in-flight request and waits
		// for its worker before another instance recovers the persisted lease.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := r1.Stop(ctx)
		cancel()
		if err != nil {
			t.Fatalf("drain and exit first instance: %v", err)
		}
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, first.row.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-arrivals:
		if id != first.row.EventID {
			t.Fatalf("unexpected retry event %s", id)
		}
	case e := <-r2.Failures():
		t.Fatal(e)
	case <-time.After(12 * time.Second):
		t.Fatal("second instance did not take over expired responsibility")
	}
	deadline := time.After(5 * time.Second)
	var newAttempt, newToken, state, outcome string
	var generation int64
	var count int
	for {
		err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,d.generation,d.automatic_attempt_count,a.id::text,a.lease_token::text,a.outcome FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id AND a.sequence=2 WHERE d.id=$1`, first.row.ID).Scan(&state, &generation, &count, &newAttempt, &newToken, &outcome)
		if err == nil && state == "delivered" {
			break
		}
		select {
		case e := <-r2.Failures():
			t.Fatal(e)
		case <-deadline:
			t.Fatalf("takeover state=%s error=%v", state, err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	if oldAttempt == newAttempt || oldToken == newToken || generation <= 1 || count != 2 || outcome != "acknowledged" {
		t.Fatalf("invalid takeover generation=%d count=%d outcome=%s", generation, count, outcome)
	}
	lateResult := "not_applicable"
	if !stopBeforeTakeover {
		once.Do(func() { close(releaseOld) })
		deadline = time.After(5 * time.Second)
		for {
			var oldOutcome string
			var late *string
			var observed *time.Time
			err := f.db.Pool.QueryRow(f.ctx, `SELECT outcome,late_outcome,recovered_unknown_at FROM webhook_attempts WHERE id=$1`, oldAttempt).Scan(&oldOutcome, &late, &observed)
			if err != nil {
				t.Fatal(err)
			}
			if late != nil {
				if oldOutcome != "unknown" || (*late != "acknowledged" && *late != "unknown") || observed == nil {
					t.Fatalf("invalid old observation outcome=%s late=%s recovered=%v", oldOutcome, *late, observed)
				}
				lateResult = *late
				break
			}
			select {
			case e := <-r1.Failures():
				t.Fatal(e)
			case <-deadline:
				t.Fatal("old late observation missing")
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	var finalState, finalOutcome string
	var finalGeneration int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,d.generation,a.outcome FROM webhook_deliveries d JOIN webhook_attempts a ON a.id=$2 WHERE d.id=$1`, first.row.ID, newAttempt).Scan(&finalState, &finalGeneration, &finalOutcome); err != nil {
		t.Fatal(err)
	}
	if finalState != "delivered" || finalGeneration != generation || finalOutcome != "acknowledged" {
		t.Fatal("old token altered new result")
	}
	t.Logf("concurrent_claims=2 first_delivery=%s old_attempt=%s new_attempt=%s generation=%d attempts=%d stopped_before_takeover=%t late_outcome=%s", first.row.ID, oldAttempt, newAttempt, generation, count, stopBeforeTakeover, lateResult)
}
