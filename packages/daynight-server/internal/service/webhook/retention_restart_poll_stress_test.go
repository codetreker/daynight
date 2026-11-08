//go:build stress

package webhook_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

// This wrapper controls only the history collector's observed clock; PostgreSQL
// timestamps and all captured source facts remain on the actual database clock.
type advancedRetentionStore struct {
	*postgres.Store
	at time.Time
}
type advancedRetentionScope struct {
	store.WebhookRetentionScope
	at time.Time
}

func (s advancedRetentionScope) ObservedAt(context.Context) (time.Time, error) { return s.at, nil }
func (s advancedRetentionStore) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	return s.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		return fn(advancedRetentionScope{WebhookRetentionScope: sc, at: s.at})
	})
}

func TestRetentionRestartChild(t *testing.T) {
	dbURL := os.Getenv("T06_RETENTION_CHILD_URL")
	if dbURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	at, err := time.Parse(time.RFC3339Nano, os.Getenv("T06_RETENTION_CHILD_TIME"))
	if err != nil {
		t.Fatalf("maintenance clock: %v", err)
	}
	n, more, err := webhook.NewRetention(advancedRetentionStore{Store: db, at: at}).Pass(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("pass %d %t\n", n, more)
}

func runRetentionChild(t *testing.T, f *captureFixture, at time.Time) (int, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRetentionRestartChild$")
	cmd.Env = append(os.Environ(), "T06_RETENTION_CHILD_URL="+f.db.Pool.Config().ConnString(), "T06_RETENTION_CHILD_TIME="+at.Format(time.RFC3339Nano))
	data, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("retention child: %v %s", err, data)
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		var n int
		var more bool
		if _, e := fmt.Sscanf(scanner.Text(), "pass %d %t", &n, &more); e == nil {
			return n, more
		}
	}
	t.Fatalf("missing child result: %s", data)
	return 0, false
}

func TestRetentionLargeAttemptRestartStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	arrived, release := make(chan struct{}, 1), make(chan struct{})
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		<-release
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(receiver.Close)
	f := newCaptureFixture(t, 501)
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
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "large audience with attempt"})
	if err != nil {
		t.Fatal(err)
	}
	observer := &observeLateTransactions{base: f.db, committed: make(chan struct{}, 1)}
	runner := webhook.NewRunner(observer, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	open := true
	t.Cleanup(func() {
		if open {
			close(release)
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
	case <-time.After(10 * time.Second):
		t.Fatal("attempt request absent")
	}
	var id, attempt string
	var count int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text,original_match_count FROM webhook_deliveries`).Scan(&id, &attempt, &count); err != nil || count != 501 {
		t.Fatalf("actual capture/attempt %d %v", count, err)
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
	deadline := time.Now().Add(10 * time.Second)
	for {
		var state string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "leased" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("recovery timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := recovery.Stop(stop); err != nil {
		t.Fatal(err)
	}
	cancel()
	var actualNow, metadata, finished, recovered time.Time
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT clock_timestamp(),d.metadata_expires_at,a.finished_at,a.recovered_unknown_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&actualNow, &metadata, &finished, &recovered); err != nil {
		t.Fatal(err)
	}
	maintenanceAt := actualNow.Add(40 * 24 * time.Hour)
	if !maintenanceAt.After(metadata) || !maintenanceAt.After(payload) || finished.Before(recordedAt) || recovered.Before(recordedAt) {
		t.Fatal("controlled maintenance time or real recovery time invalid")
	}
	var waitsBefore int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_endpoint_waits`).Scan(&waitsBefore); err != nil {
		t.Fatal(err)
	}
	n, more := runRetentionChild(t, f, maintenanceAt)
	if n != 500 || !more {
		t.Fatalf("first child pass %d %v", n, more)
	}
	var closed, payloadRemoved, factRemoved bool
	var purgeAt, closedAt time.Time
	var matches int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at IS NOT NULL AND a.retention_closed_at IS NOT NULL,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$1),d.payload_removed_at IS NOT NULL,e.fact_removed_at IS NOT NULL,d.purging_at,a.retention_closed_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&closed, &matches, &payloadRemoved, &factRemoved, &purgeAt, &closedAt); err != nil || !closed || matches < 1 || matches >= 501 {
		t.Fatalf("first child persisted closure %t matches=%d %v", closed, matches, err)
	}
	if !purgeAt.Equal(maintenanceAt) || !closedAt.Equal(maintenanceAt) {
		t.Fatalf("unexpected closure times: %v %v want %v", purgeAt, closedAt, maintenanceAt)
	}
	var waitsAfter int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_endpoint_waits`).Scan(&waitsAfter); err != nil {
		t.Fatal(err)
	}
	if waitsAfter > waitsBefore {
		t.Fatal("endpoint wait count increased during GC")
	}
	actual := 501 - matches + 2 + waitsBefore - waitsAfter
	if payloadRemoved {
		actual++
	}
	if factRemoved {
		actual++
	}
	if actual != n {
		t.Fatalf("affected rows reported=%d observed=%d matches=%d payload=%t fact=%t", n, actual, matches, payloadRemoved, factRemoved)
	}
	var afterEvent, afterDelivery, afterAutomatic, afterPayload time.Time
	var afterBody, afterFact, afterHash, afterFactHash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT e.occurred_at,d.occurred_at,d.automatic_expires_at,d.payload_expires_at,d.body,e.fact_bytes,d.body_sha256,e.fact_sha256 FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&afterEvent, &afterDelivery, &afterAutomatic, &afterPayload, &afterBody, &afterFact, &afterHash, &afterFactHash); err != nil {
		t.Fatal(err)
	}
	if !afterEvent.Equal(eventAt) || !afterDelivery.Equal(deliveryAt) || !afterAutomatic.Equal(automatic) || !afterPayload.Equal(payload) || !bytes.Equal(hash, afterHash) || !bytes.Equal(factHash, afterFactHash) || (!payloadRemoved && !bytes.Equal(afterBody, sourceBody)) || (payloadRemoved && afterBody != nil) || (!factRemoved && !bytes.Equal(afterFact, fact)) || (factRemoved && afterFact != nil) {
		t.Fatal("captured times, deadlines or retained bytes changed during GC")
	}
	close(release)
	open = false
	select {
	case <-observer.committed:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("late completion missing")
	}
	var late *time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT late_observed_at FROM webhook_attempts WHERE id=$1`, attempt).Scan(&late); err != nil || late != nil {
		t.Fatalf("closed attempt gained late result %v", err)
	}
	n, _ = runRetentionChild(t, f, maintenanceAt)
	if n < 1 || n > 500 {
		t.Fatalf("second child pass count %d", n)
	}
	var remaining int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries)+(SELECT count(*) FROM webhook_delivery_matches)+(SELECT count(*) FROM webhook_attempts)+(SELECT count(*) FROM webhook_events)`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining %d %v", remaining, err)
	}
}

type pollObservation struct {
	*postgres.Store
	starts chan time.Time
}

func (s *pollObservation) ScanWebhookConfigGC(ctx context.Context, cursor *store.WebhookConfigGCCandidate, limit int) (store.WebhookConfigGCScan, error) {
	s.starts <- time.Now()
	return s.Store.ScanWebhookConfigGC(ctx, cursor, limit)
}

func TestRetentionIndependentPollingStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	t.Run("full_batch_one_second", func(t *testing.T) {
		f := newCaptureFixture(t, 501)
		if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "poll backlog"}); err != nil {
			t.Fatal(err)
		}
		var id string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ageRetention(t, f, id, 40*24*time.Hour)
		db := &pollObservation{Store: f.db, starts: make(chan time.Time, 10)}
		maintenance := webhook.NewRetention(db)
		svc := &webhook.Service{DB: f.db}
		disabled := webhook.NewRunner(f.db, svc, false)
		if err := disabled.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := maintenance.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := maintenance.Stop(ctx); err != nil {
				t.Error(err)
			}
			if err := disabled.Stop(ctx); err != nil {
				t.Error(err)
			}
		})
		first := <-db.starts
		var second time.Time
		select {
		case second = <-db.starts:
		case err := <-maintenance.Failures():
			t.Fatal(err)
		case <-time.After(12 * time.Second):
			t.Fatal("full batch continuation absent")
		}
		if elapsed := second.Sub(first); elapsed < time.Second || elapsed > 10*time.Second {
			t.Fatalf("full batch continuation %v", elapsed)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			var count int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_deliveries`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("full batch did not converge")
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
	t.Run("idle_one_minute_without_wakeup", func(t *testing.T) {
		f, id := retentionCapture(t)
		db := &pollObservation{Store: f.db, starts: make(chan time.Time, 10)}
		maintenance := webhook.NewRetention(db)
		ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
		defer cancel()
		if err := maintenance.Start(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			stop, c := context.WithTimeout(context.Background(), 5*time.Second)
			defer c()
			if err := maintenance.Stop(stop); err != nil {
				t.Error(err)
			}
		})
		first := <-db.starts
		time.Sleep(time.Second)
		occurred := time.Now().UTC().Add(-40 * 24 * time.Hour)
		_, err := f.db.Pool.Exec(ctx, `UPDATE webhook_deliveries SET occurred_at=$2,automatic_schedule_at=ARRAY[$2::timestamptz,$2::timestamptz+interval '1 minute',$2::timestamptz+interval '5 minutes',$2::timestamptz+interval '30 minutes',$2::timestamptz+interval '2 hours',$2::timestamptz+interval '6 hours',$2::timestamptz+interval '12 hours',$2::timestamptz+interval '24 hours',$2::timestamptz+interval '48 hours',$2::timestamptz+interval '71 hours'],automatic_expires_at=$2::timestamptz+interval '72 hours',payload_expires_at=$2::timestamptz+interval '168 hours',expires_at=$2::timestamptz+interval '72 hours',last_activity_at=$2,metadata_expires_at=$2::timestamptz+interval '30 days',state='delivered',next_attempt_at=NULL WHERE id=$1`, id, occurred)
		if err != nil {
			t.Fatal(err)
		}
		var second time.Time
		select {
		case second = <-db.starts:
		case err := <-maintenance.Failures():
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal("idle poll missing")
		}
		if elapsed := second.Sub(first); elapsed < time.Minute || elapsed > 75*time.Second {
			t.Fatalf("idle poll interval %v", elapsed)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			var count int
			if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE id=$1`, id).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("idle poll did not converge")
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
}
