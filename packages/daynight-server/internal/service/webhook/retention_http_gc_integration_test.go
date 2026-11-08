package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type jointHistoryClock struct {
	store.WebhookTransactions
	at time.Time
}
type jointHistoryClockScope struct {
	store.WebhookReadScope
	at time.Time
}

func (s jointHistoryClockScope) ObservedAt(context.Context) (time.Time, error) { return s.at, nil }
func (s jointHistoryClock) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	return s.WebhookTransactions.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		return fn(jointHistoryClockScope{sc, s.at})
	})
}

// The historical Task insertion supplies the captured source time. Eligibility
// and GC comparisons use database time; the retained timestamps represent the
// same historical fixture rather than moving the observation clock.
func newJointRetentionHTTP(t *testing.T, age time.Duration) *retentionHTTP {
	return newJointRetentionHTTPTo(t, age, "")
}

func newJointRetentionHTTPTo(t *testing.T, age time.Duration, destination string) *retentionHTTP {
	t.Helper()
	f := newCaptureFixture(t, 1)
	var endpoint, delivery string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_endpoints`).Scan(&endpoint); err != nil {
		t.Fatal(err)
	}
	if destination != "" {
		var version int64
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT config_version FROM webhook_endpoints WHERE id=$1`, endpoint).Scan(&version); err != nil {
			t.Fatal(err)
		}
		svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
		m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: destination}}
		if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
			t.Fatal(err)
		}
	}
	setJointFixtureTime(t, f, endpoint, time.Now().UTC().Add(-age-31*24*time.Hour))
	trigger := fmt.Sprintf(`CREATE FUNCTION joint_historical_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at=statement_timestamp()-interval '%d microseconds'; NEW.updated_at=NEW.created_at; RETURN NEW; END $$; CREATE TRIGGER joint_historical_source BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION joint_historical_source()`, age.Microseconds())
	if _, err := f.db.Pool.Exec(f.ctx, trigger); err != nil {
		t.Fatal(err)
	}
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "joint HTTP and GC"})
	if err != nil {
		t.Fatal(err)
	}
	occurred, recorded := created.CreatedAt, created.CreatedAt.Add(time.Second)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_events SET recorded_at=$1 WHERE task_id=$2`, recorded, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=$1,last_activity_at=$1,metadata_expires_at=$1::timestamptz+interval '30 days' RETURNING endpoint_id::text,id::text`, recorded).Scan(&endpoint, &delivery); err != nil {
		t.Fatal(err)
	}
	assertJointFixtureTime(t, f, endpoint, occurred)
	var eventAt, deliveryAt, payloadAt time.Time
	var body []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT e.occurred_at,d.occurred_at,d.payload_expires_at,d.body FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, delivery).Scan(&eventAt, &deliveryAt, &payloadAt, &body); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Time string `json:"time"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	wireAt, err := time.Parse(time.RFC3339Nano, wire.Time)
	if err != nil || !occurred.Equal(eventAt) || !occurred.Equal(deliveryAt) || !occurred.Equal(wireAt) || !payloadAt.Equal(occurred.Add(7*24*time.Hour)) {
		t.Fatalf("historical Task/event/wire deadline mismatch: %v", err)
	}
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	return jointRetentionHost(t, f, svc, token, endpoint, delivery)
}

func jointRetentionHost(t *testing.T, f *captureFixture, svc *webhook.Service, token, endpoint, delivery string) *retentionHTTP {
	t.Helper()
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

func TestJointHTTPAndRetentionManual(t *testing.T) {
	t.Run("GC before a valid manual leaves the original material available", func(t *testing.T) {
		r := newJointRetentionHTTP(t, 6*24*time.Hour)
		var original []byte
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT body FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&original); err != nil {
			t.Fatal(err)
		}
		if _, _, err := webhook.NewRetention(r.f.db).Pass(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		var body []byte
		var closed bool
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT body,purging_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&body, &closed); err != nil || closed || !bytes.Equal(body, original) {
			t.Fatalf("GC damaged valid manual material: closed=%t err=%v", closed, err)
		}
		retentionReceive(t, r, r.call("POST", "/redeliveries", r.intent()), http.StatusAccepted)
		retentionCounts(t, r, 1, 1, 2)
	})
	t.Run("valid manual owns row while GC skips it", func(t *testing.T) {
		r := newJointRetentionHTTP(t, 6*24*time.Hour)
		blocker, err := r.f.db.Pool.Begin(r.f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer blocker.Rollback(context.Background())
		if _, err = blocker.Exec(r.f.ctx, `SELECT pg_advisory_xact_lock(7207101)`); err != nil {
			t.Fatal(err)
		}
		if _, err = r.f.db.Pool.Exec(r.f.ctx, `CREATE FUNCTION joint_hold_manual() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trigger='manual' THEN PERFORM pg_advisory_xact_lock(7207101); END IF; RETURN NEW; END $$; CREATE TRIGGER joint_hold_manual BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION joint_hold_manual()`); err != nil {
			t.Fatal(err)
		}
		var pid int32
		if err = blocker.QueryRow(r.f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		result := r.call("POST", "/redeliveries", r.intent())
		retentionWait(t, r, pid)
		gc := webhook.NewRetention(r.f.db)
		if _, _, err = gc.Pass(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		if err = blocker.Commit(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionReceive(t, r, result, http.StatusAccepted)
		if _, _, err = gc.Pass(r.f.ctx); err != nil {
			t.Fatal(err)
		}
		retentionCounts(t, r, 1, 1, 2)
		var body, fact []byte
		var purging bool
		var matches int
		if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT d.body,e.fact_bytes,d.purging_at IS NOT NULL,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, r.delivery).Scan(&body, &fact, &purging, &matches); err != nil || len(body) == 0 || len(fact) == 0 || purging || matches != 1 {
			t.Fatalf("manual material body=%d fact=%d purging=%t matches=%d err=%v", len(body), len(fact), purging, matches, err)
		}
	})
	t.Run("expired manual rejects before and after real GC holds lock", func(t *testing.T) {
		r := newJointRetentionHTTP(t, 31*24*time.Hour)
		retentionReceive(t, r, r.call("POST", "/redeliveries", r.intent()), http.StatusNotFound)
		retentionCounts(t, r, 0, 0, 1)
		gcStore, pid := singleBarrierStore(t, r.f, "joint_gc")
		g := &retentionLockGate{Store: gcStore, entered: make(chan struct{}), release: make(chan struct{})}
		var release sync.Once
		t.Cleanup(func() { release.Do(func() { close(g.release) }) })
		done := make(chan error, 1)
		go func() { _, _, err := webhook.NewRetention(g).Pass(r.f.ctx); done <- err }()
		select {
		case <-g.entered:
		case err := <-done:
			t.Fatalf("GC ended before close: %v", err)
		case <-time.After(time.Second):
			t.Fatal("GC did not close")
		}
		result := r.call("POST", "/redeliveries", r.intent())
		retentionWait(t, r, pid)
		release.Do(func() { close(g.release) })
		retentionReceive(t, r, result, http.StatusNotFound)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		var receipts, attempts int
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT (SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts)`).Scan(&receipts, &attempts); err != nil || receipts != 0 || attempts != 0 {
			t.Fatalf("expired intent receipts=%d attempts=%d err=%v", receipts, attempts, err)
		}
	})
}

func TestJointHistorySnapshotAndRealPurge(t *testing.T) {
	r := newJointRetentionHTTP(t, 30*24*time.Hour-3*time.Second)
	gate := &gatedHistoryStore{WebhookTransactions: r.svc.DB, entered: make(chan struct{}), resume: make(chan struct{})}
	gatedSvc := &webhook.Service{DB: gate, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	gatedHost := jointRetentionHost(t, r.f, gatedSvc, r.token, r.endpoint, r.delivery)
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate.resume) }) })
	old := gatedHost.call("GET", "", "")
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot not established")
	}
	waitRetentionDeadline(t, r, "metadata_expires_at")
	if _, _, err := webhook.NewRetention(r.f.db).Pass(r.f.ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT count(*) FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&count); err != nil || count != 0 {
		t.Fatalf("GC did not purge delivery: count=%d err=%v", count, err)
	}
	retentionReceive(t, r, r.call("GET", "", ""), http.StatusNotFound)
	release.Do(func() { close(gate.resume) })
	select {
	case got := <-old:
		if got.err != nil || got.status != http.StatusOK || !strings.Contains(got.body, r.delivery) {
			t.Fatalf("old snapshot status=%d body=%s err=%v", got.status, got.body, got.err)
		}
	case <-r.f.ctx.Done():
		t.Fatal(r.f.ctx.Err())
	}
}

func TestJointHTTPAdmittedLeaseAcrossPayloadExpiry(t *testing.T) {
	arrived, release := make(chan []byte, 1), make(chan struct{})
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err == nil {
			arrived <- body
		}
		<-release
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	r := newJointRetentionHTTPTo(t, 7*24*time.Hour-8*time.Second, receiver.URL)
	var original []byte
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT body FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&original); err != nil {
		t.Fatal(err)
	}
	intent := strings.Replace(r.intent(), `"ifVersion":"1"`, `"ifVersion":"2"`, 1)
	retentionReceive(t, r, r.call("POST", "/redeliveries", intent), http.StatusAccepted)
	runner := webhook.NewRunner(r.f.db, r.svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		releaseOnce.Do(func() { close(release) })
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case got := <-arrived:
		if !bytes.Equal(got, original) {
			t.Fatal("actual TLS payload changed")
		}
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("manual delivery was not admitted")
	}
	waitRetentionDeadline(t, r, "payload_expires_at")
	if _, _, err := webhook.NewRetention(r.f.db).Pass(r.f.ctx); err != nil {
		t.Fatal(err)
	}
	retentionReceive(t, r, r.call("GET", "/payload", ""), http.StatusGone)
	newIntent := strings.Replace(r.intent(), `"ifVersion":"1"`, `"ifVersion":"2"`, 1)
	retentionReceive(t, r, r.call("POST", "/redeliveries", newIntent), http.StatusGone)
	var body, fact []byte
	var purging, live bool
	var attempts, matches, manual, receipts int
	err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT d.body,e.fact_bytes,d.purging_at IS NOT NULL,d.lease_until>clock_timestamp(),(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id),d.manual_operation_count,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, r.delivery).Scan(&body, &fact, &purging, &live, &attempts, &matches, &manual, &receipts)
	if err != nil || purging || !live || attempts != 1 || matches != 1 || manual != 1 || receipts != 1 || !bytes.Equal(body, original) || !bytes.Equal(fact, original) {
		t.Fatalf("active lease material purging=%t live=%t attempts=%d matches=%d manual=%d receipts=%d err=%v", purging, live, attempts, matches, manual, receipts, err)
	}
	releaseOnce.Do(func() { close(release) })
}
func TestJointHTTPLateAndRetentionLockBarriers(t *testing.T) {
	for _, lateFirst := range []bool{true, false} {
		name := "close_first"
		if lateFirst {
			name = "late_first"
		}
		t.Run(name, func(t *testing.T) { testJointHTTPLateAndRetentionLockBarriers(t, lateFirst) })
	}
}
func testJointHTTPLateAndRetentionLockBarriers(t *testing.T, lateFirst bool) {
	arrived, releaseHTTP := make(chan struct{}, 1), make(chan struct{})
	var releaseOnce sync.Once
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		<-releaseHTTP
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(receiver.Close)
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "late GC lock barrier"})
	if err != nil {
		t.Fatal(err)
	}
	// This real manual request is admitted within the original seven-day window.
	// Only the subsequent recovery and late/GC observation time are controlled.
	var delivery string
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=clock_timestamp() RETURNING id::text`).Scan(&delivery); err != nil {
		t.Fatal(err)
	}
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	svc.DispatchEnabled = true
	api := jointRetentionHost(t, f, svc, token, endpoint, delivery)
	intent := strings.Replace(api.intent(), `"ifVersion":"1"`, `"ifVersion":"2"`, 1)
	retentionReceive(t, api, api.call("POST", "/redeliveries", intent), http.StatusAccepted)
	runnerDB, runnerPID := singleBarrierStore(t, f, "t06_late_lock")
	gcDB, gcPID := singleBarrierStore(t, f, "t06_gc_lock")
	observer := &observeLateTransactions{base: runnerDB, committed: make(chan struct{}, 1)}
	controlledAt := created.CreatedAt.Add(40 * 24 * time.Hour)
	clockService := &webhook.Service{DB: jointHistoryClock{f.db, controlledAt}, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	clockAPI := jointRetentionHost(t, f, clockService, token, endpoint, delivery)
	late := &lateAttemptBarrier{base: observer, locked: make(chan struct{}), release: make(chan struct{}), at: controlledAt}
	runner := webhook.NewRunner(late, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseHTTP) })
		select {
		case <-late.release:
		default:
			close(late.release)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	select {
	case <-arrived:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("real TLS request absent")
	}
	var id, attempt string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text FROM webhook_deliveries`).Scan(&id, &attempt); err != nil {
		t.Fatal(err)
	}
	var sourceAt, eventAt, deliveryAt, recordedAt, automatic, payload time.Time
	var sourceBody, fact, hash, factHash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT t.created_at,e.occurred_at,d.occurred_at,e.recorded_at,d.automatic_expires_at,d.payload_expires_at,d.body,e.fact_bytes,d.body_sha256,e.fact_sha256 FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN tasks t ON t.id=e.task_id WHERE d.id=$1`, id).Scan(&sourceAt, &eventAt, &deliveryAt, &recordedAt, &automatic, &payload, &sourceBody, &fact, &hash, &factHash); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Time string `json:"time"`
	}
	if err = json.Unmarshal(sourceBody, &wire); err != nil {
		t.Fatal(err)
	}
	wireTime, err := time.Parse(time.RFC3339Nano, wire.Time)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sourceBody)
	if !sourceAt.Equal(created.CreatedAt) || !sourceAt.Equal(eventAt) || !eventAt.Equal(deliveryAt) || !eventAt.Equal(wireTime) || !automatic.Equal(eventAt.Add(72*time.Hour)) || !payload.Equal(eventAt.Add(7*24*time.Hour)) || !bytes.Equal(sourceBody, fact) || !bytes.Equal(hash, digest[:]) || !bytes.Equal(hash, factHash) {
		t.Fatal("source, event, body, hash, and original deadlines disagree")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=clock_timestamp()-interval '46 seconds',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	recovery := webhook.NewRunner(f.db, svc, false)
	if err := recovery.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var state string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "leased" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lease recovery timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := recovery.Stop(stop); err != nil {
		t.Fatal(err)
	}
	cancel()
	var metadata, finished, recovered time.Time
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.metadata_expires_at,a.finished_at,a.recovered_unknown_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&metadata, &finished, &recovered); err != nil {
		t.Fatal(err)
	}
	if !controlledAt.After(metadata) || !controlledAt.After(payload) || finished.Before(recordedAt) || recovered.Before(recordedAt) {
		t.Fatal("controlled observation or real recovery time invalid")
	}
	gate := &retentionAttemptBarrier{Store: gcDB, locked: make(chan struct{}), release: make(chan struct{}), committed: make(chan struct{}), continuePass: make(chan struct{}), at: controlledAt}
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
		select {
		case <-gate.continuePass:
		default:
			close(gate.continuePass)
		}
	})
	assertCaptured := func() {
		t.Helper()
		var eventAfter, deliveryAfter, autoAfter, payloadAfter time.Time
		var bodyAfter, factAfter, hashAfter, factHashAfter []byte
		var payloadRemoved, factRemoved bool
		err := f.db.Pool.QueryRow(f.ctx, `SELECT e.occurred_at,d.occurred_at,d.automatic_expires_at,d.payload_expires_at,d.body,e.fact_bytes,d.body_sha256,e.fact_sha256,d.payload_removed_at IS NOT NULL,e.fact_removed_at IS NOT NULL FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&eventAfter, &deliveryAfter, &autoAfter, &payloadAfter, &bodyAfter, &factAfter, &hashAfter, &factHashAfter, &payloadRemoved, &factRemoved)
		if err != nil || !eventAfter.Equal(eventAt) || !deliveryAfter.Equal(deliveryAt) || !autoAfter.Equal(automatic) || !payloadAfter.Equal(payload) || !bytes.Equal(hashAfter, hash) || !bytes.Equal(factHashAfter, factHash) || (!payloadRemoved && !bytes.Equal(bodyAfter, sourceBody)) || (payloadRemoved && bodyAfter != nil) || (!factRemoved && !bytes.Equal(factAfter, fact)) || (factRemoved && factAfter != nil) {
			t.Fatalf("captured evidence changed: %v", err)
		}
	}
	gcDone := make(chan error, 1)
	startGC := func() { go func() { _, _, e := webhook.NewRetention(gate).Pass(f.ctx); gcDone <- e }() }
	if lateFirst {
		releaseOnce.Do(func() { close(releaseHTTP) })
		select {
		case <-late.locked:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("late writer did not lock Attempt")
		}
		close(gate.release)
		close(gate.continuePass)
		startGC()
		waitAttemptBlock(t, f, gcPID, runnerPID)
		close(late.release)
		select {
		case <-observer.committed:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("late commit missing")
		}
		if err := <-gcDone; err != nil {
			t.Fatal(err)
		}
		var purging, observed *time.Time
		var expiry time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at,a.late_observed_at,d.metadata_expires_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&purging, &observed, &expiry); err != nil || purging != nil || observed == nil || !observed.Equal(controlledAt) || !expiry.Equal(controlledAt.Add(30*24*time.Hour)) {
			t.Fatalf("late first retention state %v %v %v %v", purging, observed, expiry, err)
		}
		assertCaptured()
		retentionReceive(t, clockAPI, clockAPI.call("GET", "", ""), http.StatusOK)
	} else {
		close(late.release)
		startGC()
		select {
		case <-gate.locked:
		case err := <-gcDone:
			t.Fatalf("GC ended before barrier: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("GC did not lock Attempt")
		}
		releaseOnce.Do(func() { close(releaseHTTP) })
		waitAttemptBlock(t, f, runnerPID, gcPID)
		close(gate.release)
		select {
		case <-gate.committed:
		case err := <-gcDone:
			t.Fatalf("GC failed to close: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("close commit missing")
		}
		select {
		case <-observer.committed:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("late writer completion missing")
		}
		var closed bool
		var observed *time.Time
		var purgeAt, closedAt time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at IS NOT NULL AND a.retention_closed_at IS NOT NULL,a.late_observed_at,d.purging_at,a.retention_closed_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&closed, &observed, &purgeAt, &closedAt); err != nil || !closed || observed != nil || !purgeAt.Equal(controlledAt) || !closedAt.Equal(controlledAt) {
			t.Fatalf("close first state %t %v %v", closed, observed, err)
		}
		assertCaptured()
		retentionReceive(t, clockAPI, clockAPI.call("GET", "", ""), http.StatusNotFound)
		close(gate.continuePass)
		if err := <-gcDone; err != nil {
			t.Fatal(err)
		}
	}
}
