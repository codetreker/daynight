package webhook_test

import (
	"bytes"
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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

// Capture is held after the actual source transaction has inserted its entire
// audience, but before the source transaction commits.
type retentionCaptureGate struct {
	inner             *webhook.Capturer
	inserted, release chan struct{}
}
type retentionCaptureDAO struct {
	store.WebhookCaptureDAO
	gate *retentionCaptureGate
}

func (d retentionCaptureDAO) SaveCapture(ctx context.Context, e store.WebhookCapturedEvent, ds []store.WebhookCapturedDelivery) error {
	if err := d.WebhookCaptureDAO.SaveCapture(ctx, e, ds); err != nil {
		return err
	}
	close(d.gate.inserted)
	select {
	case <-d.gate.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (g *retentionCaptureGate) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	return g.inner.CaptureBatch(ctx, retentionCaptureDAO{d, g}, f)
}

func TestRetentionDuringUncommittedRealCapture(t *testing.T) {
	f := newCaptureFixture(t, 2)
	g := &retentionCaptureGate{inner: f.capture, inserted: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(g.release) }) })
	done := make(chan error, 1)
	go func() {
		_, err := taskservice.NewTasks(f.db, g).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "uncommitted capture"})
		done <- err
	}()
	select {
	case <-g.inserted:
	case err := <-done:
		t.Fatalf("capture: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("capture did not insert")
	}
	n, _, err := webhook.NewRetention(f.db).Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("GC during capture: %d %v", n, err)
	}
	var visible int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events)+(SELECT count(*) FROM webhook_deliveries)+(SELECT count(*) FROM webhook_delivery_matches)`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("uncommitted visible: %d %v", visible, err)
	}
	release.Do(func() { close(g.release) })
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var events, deliveries, matches int
	var complete bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_deliveries),(SELECT count(*) FROM webhook_delivery_matches),(SELECT bool_and(d.body IS NOT NULL AND d.original_match_count=2 AND d.purging_at IS NULL AND e.fact_bytes IS NOT NULL) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id)`).Scan(&events, &deliveries, &matches, &complete); err != nil || events != 1 || deliveries != 1 || matches != 2 || !complete {
		t.Fatalf("committed audience %d %d %d %v %v", events, deliveries, matches, complete, err)
	}
}

// The controlled source clock makes the original Event, body and Delivery
// deadlines agree, without waiting thirty days in the test.
type retentionOldCapture struct {
	inner    *webhook.Capturer
	occurred time.Time
}

func (c retentionOldCapture) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	for i := range f {
		f[i].OccurredAt = c.occurred
	}
	return c.inner.CaptureBatch(ctx, d, f)
}

type retentionLockGate struct {
	*postgres.Store
	entered, release chan struct{}
}
type retentionLockScope struct {
	store.WebhookRetentionScope
	gate *retentionLockGate
}

func (s retentionLockScope) CloseRetention(ctx context.Context, id string, at time.Time) (int, error) {
	n, err := s.WebhookRetentionScope.CloseRetention(ctx, id, at)
	if err != nil {
		return n, err
	}
	close(s.gate.entered)
	select {
	case <-s.gate.release:
		return n, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}
func (g *retentionLockGate) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	return g.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error { return fn(retentionLockScope{sc, g}) })
}

func TestRetentionCloseBeforeManualLock(t *testing.T) {
	f := newCaptureFixture(t, 1)
	occurred := time.Now().UTC().Add(-40 * 24 * time.Hour)
	if _, err := taskservice.NewTasks(f.db, retentionOldCapture{f.capture, occurred}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "old source"}); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=$1,last_activity_at=$1,metadata_expires_at=$1::timestamptz+interval '30 days' RETURNING id::text`, occurred).Scan(&id); err != nil {
		t.Fatal(err)
	}
	g := &retentionLockGate{Store: f.db, entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(g.release) }) })
	gcDone := make(chan error, 1)
	go func() { _, _, err := webhook.NewRetention(g).Pass(f.ctx); gcDone <- err }()
	select {
	case <-g.entered:
	case err := <-gcDone:
		t.Fatalf("GC: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("GC did not close")
	}
	conn, err := f.db.Pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	tx, err := conn.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	locked := make(chan error, 1)
	var purging *time.Time
	go func() {
		locked <- tx.QueryRow(f.ctx, `SELECT purging_at FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, id).Scan(&purging)
	}()
	pid := int32(conn.Conn().PgConn().PID())
	deadline := time.Now().Add(time.Second)
	for {
		var blocked bool
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT cardinality(pg_blocking_pids($1))>0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("manual state lock did not wait for GC")
		}
		time.Sleep(10 * time.Millisecond)
	}
	release.Do(func() { close(g.release) })
	if err = <-locked; err != nil || purging == nil {
		t.Fatalf("closed history must reject manual intent: %v %v", purging, err)
	}
	if err = tx.Rollback(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-gcDone; err != nil {
		t.Fatal(err)
	}
}

func TestRetentionManualIntentWinsDeliveryLock(t *testing.T) {
	f := newCaptureFixture(t, 1)
	occurred := time.Now().UTC().Add(-6 * 24 * time.Hour)
	if _, err := taskservice.NewTasks(f.db, retentionOldCapture{f.capture, occurred}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "manual source"}); err != nil {
		t.Fatal(err)
	}
	var id string
	var original []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,body FROM webhook_deliveries`).Scan(&id, &original); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET trigger='manual',manual_operation_id=$2,manual_operation_count=1,automatic_open=false,expires_at=payload_expires_at,next_attempt_at=clock_timestamp() WHERE id=$1`, id, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	// GC does not wait behind a locked Delivery. The pending manual state is
	// deliberately uncommitted while this pass observes the old version.
	if _, _, err = webhook.NewRetention(f.db).Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err = webhook.NewRetention(f.db).Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var body, fact []byte
	var closed bool
	var proofs int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,e.fact_bytes,d.purging_at IS NOT NULL,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&body, &fact, &closed, &proofs); err != nil || closed || proofs != 1 || !bytes.Equal(body, original) || !bytes.Equal(fact, original) {
		t.Fatalf("manual material: closed=%v proofs=%d err=%v", closed, proofs, err)
	}
}

type retentionDeliveryGate struct {
	base                                              store.WebhookDeliveryTransactions
	admitted, finish, releaseAdmission, releaseFinish chan struct{}
	admissionOnce, finishOnce                         sync.Once
}
type retentionDeliveryScope struct {
	store.WebhookDeliveryScope
	gate *retentionDeliveryGate
}

func (s retentionDeliveryScope) InsertAttempt(ctx context.Context, a store.WebhookAttempt) error {
	if err := s.WebhookDeliveryScope.InsertAttempt(ctx, a); err != nil {
		return err
	}
	s.gate.admissionOnce.Do(func() {
		close(s.gate.admitted)
		select {
		case <-s.gate.releaseAdmission:
		case <-ctx.Done():
		}
	})
	return ctx.Err()
}
func (s retentionDeliveryScope) UpdateAttempt(ctx context.Context, a store.WebhookAttempt) error {
	if err := s.WebhookDeliveryScope.UpdateAttempt(ctx, a); err != nil {
		return err
	}
	if a.FinishedAt != nil {
		s.gate.finishOnce.Do(func() {
			close(s.gate.finish)
			select {
			case <-s.gate.releaseFinish:
			case <-ctx.Done():
			}
		})
	}
	return ctx.Err()
}
func (g *retentionDeliveryGate) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	return g.base.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error { return fn(retentionDeliveryScope{sc, g}) })
}

// Confirm the actual delivery transaction owns the row, while GC skips its
// locked candidate rather than waiting on it.
func retentionBlockedProbe(t *testing.T, f *captureFixture, id string, release func()) {
	t.Helper()
	conn, err := f.db.Pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	tx, err := conn.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	done := make(chan error, 1)
	go func() {
		var v string
		done <- tx.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, id).Scan(&v)
	}()
	pid := int32(conn.Conn().PgConn().PID())
	deadline := time.Now().Add(time.Second)
	for {
		var blocked bool
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT cardinality(pg_blocking_pids($1))>0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("delivery lock was not held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	release()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRetentionDuringRealAdmissionAndFinalize(t *testing.T) {
	requests := make(chan []byte, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, e := io.ReadAll(r.Body)
		if e == nil {
			requests <- b
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "admission and finalize"}); err != nil {
		t.Fatal(err)
	}
	var id string
	var body []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,body FROM webhook_deliveries`).Scan(&id, &body); err != nil {
		t.Fatal(err)
	}
	g := &retentionDeliveryGate{base: f.db, admitted: make(chan struct{}), finish: make(chan struct{}), releaseAdmission: make(chan struct{}), releaseFinish: make(chan struct{})}
	var releaseAdmission, releaseFinish sync.Once
	defer releaseAdmission.Do(func() { close(g.releaseAdmission) })
	defer releaseFinish.Do(func() { close(g.releaseFinish) })
	runner := webhook.NewRunner(g, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		releaseAdmission.Do(func() { close(g.releaseAdmission) })
		releaseFinish.Do(func() { close(g.releaseFinish) })
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	gc := webhook.NewRetention(f.db)
	select {
	case <-g.admitted:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("admission absent")
	}
	if n, _, err := gc.Pass(f.ctx); err != nil || n != 0 {
		t.Fatalf("GC during admission %d %v", n, err)
	}
	retentionBlockedProbe(t, f, id, func() { releaseAdmission.Do(func() { close(g.releaseAdmission) }) })
	select {
	case got := <-requests:
		if !bytes.Equal(got, body) {
			t.Fatal("original request changed")
		}
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("TLS request absent")
	}
	select {
	case <-g.finish:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("finalize absent")
	}
	if _, _, err := gc.Pass(f.ctx); err != nil {
		t.Fatalf("GC during finalize: %v", err)
	}
	retentionBlockedProbe(t, f, id, func() { releaseFinish.Do(func() { close(g.releaseFinish) }) })
	deadline := time.Now().Add(5 * time.Second)
	for {
		var state string
		var stored []byte
		var closed bool
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,body,purging_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`, id).Scan(&state, &stored, &closed); err != nil {
			t.Fatal(err)
		}
		if state == "delivered" {
			if closed || !bytes.Equal(stored, body) {
				t.Fatal("GC removed active material")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("finalize state %s", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRetentionProtectsRealAdmissionAcrossPayloadDeadline(t *testing.T) {
	arrived, release := make(chan []byte, 1), make(chan struct{})
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err == nil {
			arrived <- body
		}
		<-release
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	// This controlled event clock leaves a few seconds for actual admission,
	// then the already admitted request crosses the immutable seven-day edge.
	occurred := time.Now().UTC().Add(-7*24*time.Hour + 6*time.Second)
	if _, err := taskservice.NewTasks(f.db, retentionOldCapture{f.capture, occurred}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "cross expiry"}); err != nil {
		t.Fatal(err)
	}
	var id string
	var body []byte
	var expiry time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_deliveries SET trigger='manual',manual_operation_id=$1,manual_operation_count=1,automatic_open=false,expires_at=payload_expires_at,next_attempt_at=clock_timestamp() RETURNING id::text,body,payload_expires_at`, uuid.NewString()).Scan(&id, &body, &expiry); err != nil {
		t.Fatal(err)
	}
	runner := webhook.NewRunner(f.db, svc, true)
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
		if !bytes.Equal(got, body) {
			t.Fatal("admitted bytes differ")
		}
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("manual admission absent")
	}
	if delay := time.Until(expiry) + 50*time.Millisecond; delay > 0 {
		time.Sleep(delay)
	}
	if _, _, err := webhook.NewRetention(f.db).Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var stored, fact []byte
	var purging bool
	var attempts, proofs int
	var live bool
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.body,e.fact_bytes,d.purging_at IS NOT NULL,d.lease_until>clock_timestamp(),(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&stored, &fact, &purging, &live, &attempts, &proofs); err != nil || purging || !live || attempts != 1 || proofs != 1 || !bytes.Equal(stored, body) || !bytes.Equal(fact, body) {
		t.Fatalf("cross-deadline lease: closed=%v live=%v attempts=%d proofs=%d err=%v", purging, live, attempts, proofs, err)
	}
	releaseOnce.Do(func() { close(release) })
}
