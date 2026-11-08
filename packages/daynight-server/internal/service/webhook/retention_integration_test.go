package webhook_test

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func retentionCapture(t *testing.T) (*captureFixture, string) {
	t.Helper()
	f := newCaptureFixture(t, 1)
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "retention"}); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return f, id
}
func ageRetention(t *testing.T, f *captureFixture, id string, age time.Duration) {
	t.Helper()
	occurred := time.Now().UTC().Add(-age)
	_, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET occurred_at=$2,automatic_schedule_at=ARRAY[$2::timestamptz,$2::timestamptz+interval '1 minute',$2::timestamptz+interval '5 minutes',$2::timestamptz+interval '30 minutes',$2::timestamptz+interval '2 hours',$2::timestamptz+interval '6 hours',$2::timestamptz+interval '12 hours',$2::timestamptz+interval '24 hours',$2::timestamptz+interval '48 hours',$2::timestamptz+interval '71 hours'],automatic_expires_at=$2::timestamptz+interval '72 hours',payload_expires_at=$2::timestamptz+interval '168 hours',expires_at=$2::timestamptz+interval '72 hours',last_activity_at=$2,metadata_expires_at=$2::timestamptz+interval '30 days',state='delivered',next_attempt_at=NULL WHERE id=$1`, id, occurred)
	if err != nil {
		t.Fatal(err)
	}
}
func TestRetentionPayloadAndHistory(t *testing.T) {
	f, id := retentionCapture(t)
	var body, hash, target []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT body,body_sha256,destination_ciphertext FROM webhook_deliveries WHERE id=$1`, id).Scan(&body, &hash, &target); err != nil {
		t.Fatal(err)
	}
	r := webhook.NewRetention(f.db)
	n, _, err := r.Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("fresh: %d %v", n, err)
	}
	ageRetention(t, f, id, 8*24*time.Hour)
	n, _, err = r.Pass(f.ctx)
	if err != nil || n != 2 {
		t.Fatalf("payload: %d %v", n, err)
	}
	var removed *time.Time
	var reason *string
	var afterBody, afterHash, afterTarget []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT body,body_sha256,destination_ciphertext,payload_removed_at,payload_removed_reason FROM webhook_deliveries WHERE id=$1`, id).Scan(&afterBody, &afterHash, &afterTarget, &removed, &reason); err != nil {
		t.Fatal(err)
	}
	if len(body) == 0 || afterBody != nil || removed == nil || reason == nil || *reason != "expired" || !bytes.Equal(hash, afterHash) || !bytes.Equal(target, afterTarget) {
		t.Fatal("payload expiry changed retained identity or target")
	}
	var factRemoved bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT fact_bytes IS NULL AND fact_removed_at IS NOT NULL FROM webhook_events`).Scan(&factRemoved); err != nil || !factRemoved {
		t.Fatalf("event fact not removed: %v", err)
	}
	ageRetention(t, f, id, 40*24*time.Hour)
	n, _, err = r.Pass(f.ctx)
	if err != nil || n != 4 {
		t.Fatalf("history: %d %v", n, err)
	}
	var deliveries, events, matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries),(SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_delivery_matches)`).Scan(&deliveries, &events, &matches); err != nil {
		t.Fatal(err)
	}
	if deliveries != 0 || events != 0 || matches != 0 {
		t.Fatalf("remaining %d %d %d", deliveries, events, matches)
	}
}
func TestRetentionProtectsActiveLease(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	token := uuid.NewString()
	_, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=$2,lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds',lease_generation=generation WHERE id=$1`, id, token)
	if err != nil {
		t.Fatal(err)
	}
	n, _, err := webhook.NewRetention(f.db).Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("active: %d %v", n, err)
	}
	var present bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT body IS NOT NULL AND purging_at IS NULL FROM webhook_deliveries WHERE id=$1`, id).Scan(&present); err != nil || !present {
		t.Fatalf("material lost: %v", err)
	}
}

func TestRetentionSharedEventProtectsActiveOwner(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	name, enabled := "team receiver", true
	m := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "team", ID: team}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "shared"}); err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT id::text FROM webhook_deliveries ORDER BY owner_kind`)
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
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("got %d deliveries", len(ids))
	}
	for _, id := range ids {
		ageRetention(t, f, id, 8*24*time.Hour)
	}
	_, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=$2,lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds',lease_generation=generation WHERE id=$1`, ids[1], uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	r := webhook.NewRetention(f.db)
	n, _, err := r.Pass(f.ctx)
	if err != nil || n != 1 {
		t.Fatalf("first owner: %d %v", n, err)
	}
	var hasFact, firstGone, secondPresent bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT fact_bytes IS NOT NULL FROM webhook_events),(SELECT body IS NULL FROM webhook_deliveries WHERE id=$1),(SELECT body IS NOT NULL FROM webhook_deliveries WHERE id=$2)`, ids[0], ids[1]).Scan(&hasFact, &firstGone, &secondPresent); err != nil || !hasFact || !firstGone || !secondPresent {
		t.Fatalf("shared event was not protected: %v", err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='delivered',lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL WHERE id=$1`, ids[1])
	if err != nil {
		t.Fatal(err)
	}
	n, _, err = r.Pass(f.ctx)
	if err != nil || n != 2 {
		t.Fatalf("last payload: %d %v", n, err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT fact_bytes IS NULL AND fact_removed_at IS NOT NULL FROM webhook_events`).Scan(&hasFact); err != nil || !hasFact {
		t.Fatalf("event expiry: %v", err)
	}
	ageRetention(t, f, ids[0], 40*24*time.Hour)
	if _, _, err = r.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var events, deliveries, matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_deliveries),(SELECT count(*) FROM webhook_delivery_matches)`).Scan(&events, &deliveries, &matches); err != nil || events != 1 || deliveries != 1 || matches != 1 {
		t.Fatalf("other owner was not retained: events=%d deliveries=%d matches=%d err=%v", events, deliveries, matches, err)
	}
	ageRetention(t, f, ids[1], 40*24*time.Hour)
	if _, _, err = r.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_deliveries)`).Scan(&events, &deliveries); err != nil || events != 0 || deliveries != 0 {
		t.Fatalf("last delivery did not release event: events=%d deliveries=%d err=%v", events, deliveries, err)
	}
}

func TestRetentionProtectsValidManualIntent(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 6*24*time.Hour)
	_, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='pending',trigger='manual',manual_operation_id=$2,manual_operation_count=1,expires_at=payload_expires_at,next_attempt_at=clock_timestamp(),automatic_open=false WHERE id=$1`, id, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	n, _, err := webhook.NewRetention(f.db).Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("manual intent: %d %v", n, err)
	}
	var body, fact bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body IS NOT NULL,e.fact_bytes IS NOT NULL FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&body, &fact); err != nil || !body || !fact {
		t.Fatalf("manual material lost: %v", err)
	}
}

func TestRetentionOriginalDeadlinesWithDeliveryRecovery(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 72*time.Hour+time.Minute)
	_, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='pending',trigger='automatic',automatic_open=true,expires_at=automatic_expires_at,next_attempt_at=automatic_schedule_at[1] WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys}
	runner := newTestRunner(f.db, svc, false)
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
	until := time.Now().Add(5 * time.Second)
	for {
		var state string
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "failed" {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("automatic deadline not materialized: %s", state)
		}
		time.Sleep(20 * time.Millisecond)
	}
	gc := webhook.NewRetention(f.db)
	n, _, err := gc.Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("72-hour deadline removed payload: %d %v", n, err)
	}
	ageRetention(t, f, id, 7*24*time.Hour-time.Minute)
	n, _, err = gc.Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("payload expired early: %d %v", n, err)
	}
	ageRetention(t, f, id, 7*24*time.Hour+time.Minute)
	n, _, err = gc.Pass(f.ctx)
	if err != nil || n != 2 {
		t.Fatalf("payload did not expire: %d %v", n, err)
	}
	ageRetention(t, f, id, 30*24*time.Hour-time.Minute)
	n, _, err = gc.Pass(f.ctx)
	if err != nil || n != 0 {
		t.Fatalf("metadata expired early: %d %v", n, err)
	}
	ageRetention(t, f, id, 30*24*time.Hour+time.Minute)
	n, _, err = gc.Pass(f.ctx)
	if err != nil || n != 4 {
		t.Fatalf("metadata did not expire: %d %v", n, err)
	}
}
