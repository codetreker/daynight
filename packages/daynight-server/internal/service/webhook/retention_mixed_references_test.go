package webhook_test

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

// The capture is committed before reclamation. This test exercises real
// reference checks and locks, while separate tests verify the XID barrier.
type passedMixedConfigBarrier struct{ *postgres.Store }

func (s passedMixedConfigBarrier) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return true, nil
}

// Mixed retained references are checked against the real capture, management
// mutations, and maintenance component. The event clock and receipt ages are
// controlled so the test need not wait for the real retention intervals.
func TestRetentionMixedConfigReferencesAndDeletedOwner(t *testing.T) {
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	name, enabled := "other receiver", true
	create := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://other.example/hook"}, HasSubscriptions: true, Subscriptions: []core.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}}
	if _, err := svc.Mutate(f.ctx, f.principal, owner, create); err != nil {
		t.Fatal(err)
	}
	var endpoint, other string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT id::text FROM webhook_endpoints WHERE name='Receiver'),(SELECT id::text FROM webhook_endpoints WHERE name='other receiver')`).Scan(&endpoint, &other); err != nil {
		t.Fatal(err)
	}
	rotate := webhook.Mutation{Kind: "signing.rotate", EndpointID: other, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("b", 64), Mode: "overlap"}
	if _, err := svc.Mutate(f.ctx, f.principal, owner, rotate); err != nil {
		t.Fatal(err)
	}
	occurred := time.Now().UTC().Add(-40 * 24 * time.Hour)
	if _, err := taskservice.NewTasks(f.db, retentionOldCapture{f.capture, occurred}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "retained proof"}); err != nil {
		t.Fatal(err)
	}
	var delivery, subscription, binding string
	var target []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,m.subscription_id::text,m.binding_id::text,d.destination_configuration FROM webhook_deliveries d JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE d.endpoint_id=$1`, endpoint).Scan(&delivery, &subscription, &binding, &target); err != nil {
		t.Fatal(err)
	}
	remove := webhook.Mutation{Kind: "endpoint.delete", EndpointID: endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("c", 64)}
	if _, err := svc.Mutate(f.ctx, f.principal, owner, remove); err != nil {
		t.Fatal(err)
	}
	// This isolated fixture removes the owner after the real deletion. System
	// maintenance must not rely on a currently authorizable principal.
	if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM users WHERE id=$1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	gc := webhook.NewRetention(passedMixedConfigBarrier{f.db})
	for i := 0; i < 5; i++ {
		if _, _, err := gc.Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	var tomb, subRetired, bindingRetired bool
	var matches, receipts, current, overlap int
	var retainedTarget []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1 AND deleted_at IS NOT NULL),EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=$2 AND deleted_at IS NOT NULL),EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$3 AND deleted_at IS NOT NULL),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$4),(SELECT count(*) FROM webhook_operations WHERE endpoint_id=$1),(SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$5 AND slot='current'),(SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$5 AND slot='overlap' AND overlap_until>clock_timestamp()),(SELECT destination_configuration FROM webhook_deliveries WHERE id=$4)`, endpoint, subscription, binding, delivery, other).Scan(&tomb, &subRetired, &bindingRetired, &matches, &receipts, &current, &overlap, &retainedTarget); err != nil || !tomb || !subRetired || !bindingRetired || matches != 1 || receipts != 2 || current != 1 || overlap != 1 || !bytes.Equal(target, retainedTarget) {
		t.Fatalf("retained references tomb=%v sub=%v binding=%v matches=%d receipts=%d keys=%d/%d err=%v", tomb, subRetired, bindingRetired, matches, receipts, current, overlap, err)
	}
	// Age only the terminated Delivery's activity. The real original Event and
	// its body were rendered with the same controlled occurrence timestamp.
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=$2,last_activity_at=$2,metadata_expires_at=$2::timestamptz+interval '30 days' WHERE id=$1`, delivery, occurred); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, _, err := gc.Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
		var remaining int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE id=$1)+(SELECT count(*) FROM webhook_subscriptions WHERE id=$2)+(SELECT count(*) FROM webhook_bindings WHERE id=$3)`, delivery, subscription, binding).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("retired proof did not converge: %d", remaining)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1),(SELECT count(*) FROM webhook_operations WHERE endpoint_id=$1),(SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$2 AND (slot='current' OR (slot='overlap' AND overlap_until>clock_timestamp())))`, endpoint, other).Scan(&tomb, &receipts, &current); err != nil || !tomb || receipts != 2 || current != 2 {
		t.Fatalf("receipt tombstone or active keys lost: %v %d %d %v", tomb, receipts, current, err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_operations SET recorded_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE endpoint_id=$1`, endpoint); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(10 * time.Second)
	for {
		if _, _, err := gc.Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1)`, endpoint).Scan(&tomb); err != nil {
			t.Fatal(err)
		}
		if !tomb {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unreferenced tombstone did not converge")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$1 AND slot='current'),(SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$1 AND slot='overlap' AND overlap_until>clock_timestamp()),(SELECT count(*) FROM users WHERE id=$2)`, other, owner.ID).Scan(&current, &overlap, &matches); err != nil || current != 1 || overlap != 1 || matches != 0 {
		t.Fatalf("surviving keys or removed owner: %d/%d owner=%d %v", current, overlap, matches, err)
	}
}
