package webhook_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestDeliveryRunnerDisabledRecoversAndExpires(t *testing.T) {
	var requests atomic.Int64
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { requests.Add(1); w.WriteHeader(http.StatusAccepted) }))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
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
	tasks := taskservice.NewTasks(f.db, f.capture)
	for i := 0; i < 3; i++ {
		if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "recovery source"}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT id::text FROM webhook_deliveries ORDER BY queue_order`)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(ids) != 3 {
		t.Fatalf("deliveries=%v err=%v", ids, err)
	}
	for _, id := range ids[:2] {
		if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds',lease_generation=generation WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	attempt := uuid.NewString()
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at) SELECT $2::uuid,d.id,d.endpoint_id,d.generation,1,'automatic',d.lease_token,d.destination_revision,ARRAY[e.active_key_id],1,d.lease_claimed_at,d.lease_claimed_at+interval '1 second' FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, ids[1], attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET current_attempt_id=$2,lease_plan_slot=1,attempt_sequence=1,automatic_attempt_count=1,automatic_plan_cursor=1 WHERE id=$1`, ids[1], attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, ids[2]); err != nil {
		t.Fatal(err)
	}
	runner := webhook.NewRunner(f.db, svc, false)
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
	}()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		var state0, state1, state2 string
		var gen0, gen1 int64
		var unknown *time.Time
		var outcome *string
		var count int
		err = f.db.Pool.QueryRow(f.ctx, `SELECT d0.state,d0.generation,d1.state,d1.generation,d2.state,a.recovered_unknown_at,a.outcome,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries d0 CROSS JOIN webhook_deliveries d1 CROSS JOIN webhook_deliveries d2 JOIN webhook_attempts a ON a.id=$4 WHERE d0.id=$1 AND d1.id=$2 AND d2.id=$3`, ids[0], ids[1], ids[2], attempt).Scan(&state0, &gen0, &state1, &gen1, &state2, &unknown, &outcome, &count)
		if err != nil {
			t.Fatal(err)
		}
		if state0 == "pending" && gen0 == 2 && state1 == "pending" && gen1 == 2 && state2 == "failed" && unknown != nil && outcome != nil && *outcome == "unknown" && count == 1 {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err = runner.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 0 {
				t.Fatal("disabled runner sent a request")
			}
			return
		}
		select {
		case e := <-runner.Failures():
			t.Fatalf("runner failed: %v", e)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("disabled runner did not recover leases and expire pending work")
}

func TestDeliveryRunnerReportsPermanentDatabaseFailure(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "failing recovery source"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds',lease_generation=generation`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DROP TABLE webhook_attempts`); err != nil {
		t.Fatal(err)
	}
	runner := webhook.NewRunner(f.db, &webhook.Service{DB: f.db, Keys: f.capture.Keys}, false)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
	}()
	select {
	case e := <-runner.Failures():
		if e == nil {
			t.Fatal("nil worker failure")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("permanent worker failure was not reported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}
