package webhook_test

import (
	"context"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Two independently owned runtimes share PostgreSQL. One drains a confirmed
// in-flight request while the other continues processing the queued work.
func TestDeliveryTwoRunnersDrainAndContinue(t *testing.T) {
	arrival := make(chan string, 8)
	release := make(chan struct{})
	var once sync.Once
	var firstID string
	var mu sync.Mutex
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("Webhook-Id")
		_, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		isFirst := firstID == ""
		if isFirst {
			firstID = id
		}
		mu.Unlock()
		arrival <- id
		if isFirst {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	defer once.Do(func() { close(release) })
	f := newCaptureFixture(t, 1)
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
	tasks := taskservice.NewTasks(f.db, f.capture)
	if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "first runner"}); err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT event_id::text FROM webhook_deliveries ORDER BY queue_order`)
	if err != nil {
		t.Fatal(err)
	}
	var events []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		events = append(events, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%v error=%v", events, err)
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, f.db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	second := &postgres.Store{Pool: pool}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	newRunner := func(db *postgres.Store) *webhook.Runner {
		r := newTestRunner(db, svc, true)
		r.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
		return r
	}
	r1, r2 := newRunner(f.db), newRunner(second)
	stop := func(r *webhook.Runner) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.Stop(ctx); err != nil {
			t.Error(err)
		}
	}
	if err := r1.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer stop(r1)
	select {
	case id := <-arrival:
		if id != events[0] {
			t.Fatalf("first eligible FIFO event=%s want=%s", id, events[0])
		}
	case err := <-r1.Failures():
		t.Fatalf("first runner: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("first receiver request missing")
	}
	// Stop only new claims. The already admitted first request remains live.
	r1.StopClaims()
	for i := 0; i < 2; i++ {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "second runner"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := r2.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer stop(r2)
	seen := map[string]bool{events[0]: true}
	for i := 0; i < 2; i++ {
		select {
		case id := <-arrival:
			if seen[id] {
				t.Fatalf("duplicate event %s", id)
			}
			seen[id] = true
		case err := <-r2.Failures():
			t.Fatalf("second runner: %v", err)
		case <-time.After(5 * time.Second):
			t.Fatal("second runner did not continue work")
		}
	}
	var state string
	var attempts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,(SELECT count(*) FROM webhook_attempts a WHERE a.delivery_id=d.id) FROM webhook_deliveries d WHERE event_id=$1`, events[0]).Scan(&state, &attempts); err != nil || state != "leased" || attempts != 1 {
		t.Fatalf("first in-flight state=%s attempts=%d err=%v", state, attempts, err)
	}
	once.Do(func() { close(release) })
	deadline := time.After(8 * time.Second)
	for {
		var delivered, total, uniqueTokens int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE state='delivered'),(SELECT count(*) FROM webhook_attempts WHERE outcome='acknowledged'),(SELECT count(DISTINCT lease_token) FROM webhook_attempts)`).Scan(&delivered, &total, &uniqueTokens)
		if err != nil {
			t.Fatal(err)
		}
		if delivered == 3 && total == 3 && uniqueTokens == 3 {
			t.Logf("first_event=%s delivered=%d acknowledged=%d distinct_lease_tokens=%d", events[0], delivered, total, uniqueTokens)
			break
		}
		select {
		case err := <-r1.Failures():
			t.Fatalf("first runner: %v", err)
		case err := <-r2.Failures():
			t.Fatalf("second runner: %v", err)
		case <-deadline:
			t.Fatalf("delivered=%d acknowledgements=%d distinct leases=%d", delivered, total, uniqueTokens)
		case <-time.After(20 * time.Millisecond):
		}
	}
}
