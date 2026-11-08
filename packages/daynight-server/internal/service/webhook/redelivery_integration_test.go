package webhook_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

func TestRedeliveryRealIntentAndRunner(t *testing.T) {
	requests := make(chan observedRequest, 4)
	var n atomic.Int64
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		requests <- observedRequest{body: b, id: r.Header.Get("Webhook-Id"), timestamp: r.Header.Get("Webhook-Timestamp"), signature: r.Header.Get("Webhook-Signature")}
		if n.Add(1) == 3 {
			w.WriteHeader(http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusAccepted)
		}
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	var endpoint string
	var config int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &config); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Mutate(f.ctx, f.principal, owner, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: config, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/hook"}})
	if err != nil {
		t.Fatal(err)
	}
	config++
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "redelivery source"}); err != nil {
		t.Fatal(err)
	}
	var id, event string
	var original []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text,event_id::text,body FROM webhook_deliveries`).Scan(&id, &event, &original); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := newTestRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
	})
	await := func(count int, expected string) {
		t.Helper()
		select {
		case got := <-requests:
			if got.id != event || !bytes.Equal(got.body, original) || got.timestamp == "" || got.signature == "" {
				t.Fatalf("request %d lost identity, bytes or authentication", count)
			}
		case e := <-runner.Failures():
			t.Fatalf("runner: %v", e)
		case <-time.After(10 * time.Second):
			t.Fatal("receiver timeout")
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var state string
			var seq, manual, automatic int
			var open bool
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,attempt_sequence,manual_operation_count,automatic_attempt_count,automatic_open FROM webhook_deliveries WHERE id=$1`, id).Scan(&state, &seq, &manual, &automatic, &open); err != nil {
				t.Fatal(err)
			}
			if state == expected && seq == count && manual == count-1 && automatic == 1 && !open {
				return
			}
			select {
			case e := <-runner.Failures():
				t.Fatalf("runner: %v", e)
			case <-time.After(20 * time.Millisecond):
			}
		}
		t.Fatalf("delivery %d did not finish in %s", count, expected)
	}
	await(1, "delivered")
	for i := int64(1); i <= 3; i++ {
		m := webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: config, IfGeneration: i, RequestSHA256: strings.Repeat("b", 64)}
		result, e := svc.Redeliver(f.ctx, f.principal, owner, endpoint, id, m)
		if e != nil || result.Replay {
			t.Fatalf("intent %d: %+v %v", i, result, e)
		}
		replay, e := svc.Redeliver(f.ctx, f.principal, owner, endpoint, id, m)
		if e != nil || !replay.Replay {
			t.Fatalf("replay %d: %+v %v", i, replay, e)
		}
		state := "delivered"
		if i == 2 {
			state = "failed"
		}
		await(int(i)+1, state)
	}
	_, err = svc.Redeliver(f.ctx, f.principal, owner, endpoint, id, webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: config, IfGeneration: 4, RequestSHA256: strings.Repeat("c", 64)})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "delivery_stopped" {
		t.Fatalf("fourth intent: %v", err)
	}
	var receipts, attempts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts WHERE trigger='manual')`).Scan(&receipts, &attempts); err != nil || receipts != 3 || attempts != 3 {
		t.Fatalf("receipts=%d attempts=%d err=%v", receipts, attempts, err)
	}
}

func TestRedeliveryAtomicityAndConcurrentIntent(t *testing.T) {
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "atomic intent"}); err != nil {
		t.Fatal(err)
	}
	var endpoint, delivery string
	var oldTicket int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text,queue_order FROM webhook_deliveries`).Scan(&endpoint, &delivery, &oldTicket); err != nil {
		t.Fatal(err)
	}
	newIntent := func() webhook.Redelivery {
		return webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("d", 64)}
	}
	svc.DispatchEnabled = false
	_, err := svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, newIntent())
	var unavailable *model.Fault
	if !errors.As(err, &unavailable) || unavailable.Code != "webhooks_unavailable" {
		t.Fatalf("disabled dispatch: %v", err)
	}
	svc.DispatchEnabled = true
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION refuse_redelivery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='delivery.redeliver' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_redelivery_receipt BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION refuse_redelivery_receipt()`); err != nil {
		t.Fatal(err)
	}
	failed := newIntent()
	if _, err := svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, failed); err == nil {
		t.Fatal("receipt failure accepted")
	}
	var generation, ticket int64
	var manual, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT generation,manual_operation_count,queue_order,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&generation, &manual, &ticket, &receipts); err != nil || generation != 1 || manual != 0 || ticket != oldTicket || receipts != 0 {
		t.Fatalf("failed intent was not rolled back: gen=%d manual=%d ticket=%d receipts=%d err=%v", generation, manual, ticket, receipts, err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DROP TRIGGER refuse_redelivery_receipt ON webhook_operations; DROP FUNCTION refuse_redelivery_receipt()`); err != nil {
		t.Fatal(err)
	}
	a, b := newIntent(), newIntent()
	start := make(chan struct{})
	errs := make(chan error, 2)
	for _, intent := range []webhook.Redelivery{a, b} {
		go func(m webhook.Redelivery) {
			<-start
			_, err := svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, m)
			errs <- err
		}(intent)
	}
	close(start)
	var successes, conflicts int
	for range 2 {
		err := <-errs
		if err == nil {
			successes++
			continue
		}
		var fault *model.Fault
		if errors.As(err, &fault) && (fault.Code == "generation_conflict" || fault.Code == "delivery_busy") {
			conflicts++
		} else {
			t.Fatalf("concurrent intent: %v", err)
		}
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT generation,manual_operation_count,queue_order,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&generation, &manual, &ticket, &receipts); err != nil || successes != 1 || conflicts != 1 || generation != 2 || manual != 1 || ticket <= oldTicket || receipts != 1 {
		t.Fatalf("concurrent effects: successes=%d conflicts=%d gen=%d manual=%d ticket=%d receipts=%d err=%v", successes, conflicts, generation, manual, ticket, receipts, err)
	}
	var accepted string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT manual_operation_id::text FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	winner := a
	if accepted == b.OperationID {
		winner = b
	}
	svc.DispatchEnabled = false
	if result, err := svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, winner); err != nil || !result.Replay {
		t.Fatalf("disabled dispatch lost original receipt: %+v %v", result, err)
	}
}

func TestRedeliveryExpiredLeaseRecovery(t *testing.T) {
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, DispatchEnabled: true}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "lease"}); err != nil {
		t.Fatal(err)
	}
	var endpoint, delivery string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text FROM webhook_deliveries`).Scan(&endpoint, &delivery); err != nil {
		t.Fatal(err)
	}
	intent := func() webhook.Redelivery {
		return webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("a", 64)}
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds',lease_generation=generation WHERE id=$1`, delivery); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, intent())
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "delivery_busy" {
		t.Fatalf("live lease: %v", err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds' WHERE id=$1`, delivery); err != nil {
		t.Fatal(err)
	}
	attempt := uuid.NewString()
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at) SELECT $2::uuid,d.id,d.endpoint_id,d.generation,1,'automatic',d.lease_token,d.destination_revision,ARRAY[e.active_key_id],1,d.lease_claimed_at,d.lease_claimed_at+interval '1 second' FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, delivery, attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET current_attempt_id=$2,lease_plan_slot=1,attempt_sequence=1,automatic_attempt_count=1,automatic_plan_cursor=1 WHERE id=$1`, delivery, attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, intent()); err != nil {
		t.Fatalf("expired admitted lease: %v", err)
	}
	var state, trigger string
	var outcome *string
	var recovered *time.Time
	var generation int64
	var automatic, manual, sequence int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.state,d.trigger,d.generation,d.automatic_attempt_count,d.manual_operation_count,d.attempt_sequence,a.outcome,a.recovered_unknown_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.id=$2 WHERE d.id=$1`, delivery, attempt).Scan(&state, &trigger, &generation, &automatic, &manual, &sequence, &outcome, &recovered); err != nil || state != "pending" || trigger != "manual" || generation != 2 || automatic != 1 || manual != 1 || sequence != 1 || outcome == nil || *outcome != "unknown" || recovered == nil {
		t.Fatalf("lease recovery lost attempt or counts: %s %s %d %d %d %d %v %v %v", state, trigger, generation, automatic, manual, sequence, outcome, recovered, err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds',lease_generation=generation WHERE id=$1`, delivery); err != nil {
		t.Fatal(err)
	}
	next := intent()
	next.IfGeneration = 2
	_, err = svc.Redeliver(f.ctx, f.principal, owner, endpoint, delivery, next)
	if !errors.As(err, &fault) || fault.Code != "delivery_busy" {
		t.Fatalf("unadmitted manual lease lost its intent: %v", err)
	}
}
