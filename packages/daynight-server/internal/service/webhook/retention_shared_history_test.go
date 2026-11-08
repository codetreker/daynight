package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

// Only the maintenance clock advances; source timestamps, activity and original
// persisted bytes are never rewritten when the test crosses the second expiry.
type sharedHistoryFutureStore struct {
	*postgres.Store
	advance time.Duration
}
type sharedHistoryFutureScope struct {
	store.WebhookRetentionScope
	advance time.Duration
}

func (s sharedHistoryFutureScope) ObservedAt(ctx context.Context) (time.Time, error) {
	now, err := s.WebhookRetentionScope.ObservedAt(ctx)
	return now.Add(s.advance), err
}
func (s *sharedHistoryFutureStore) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	return s.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error { return fn(sharedHistoryFutureScope{sc, s.advance}) })
}

func TestRetentionSharedEventConsistentHistoryAndRestart(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	name, enabled := "team receiver", true
	m := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("d", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://team.example/hook"}, HasSubscriptions: true, Subscriptions: []core.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "team", ID: team}, m); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Add(-40 * 24 * time.Hour).Truncate(time.Microsecond)
	if _, err := taskservice.NewTasks(f.db, retentionDeadlineCapture{f.capture, at}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "shared retained history"}); err != nil {
		t.Fatal(err)
	}
	var eventID, first, second, sub, binding string
	var eventAt, eventRecorded, firstAt, secondAt time.Time
	var fact, eventHash, firstBody, secondBody, target, proofHash []byte
	var originalFact, proofCount int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT e.id::text,e.occurred_at,e.recorded_at,e.fact_bytes,e.fact_sha256,e.original_fact_bytes,a.id::text,a.occurred_at,a.body,b.id::text,b.occurred_at,b.body,b.destination_ciphertext,b.original_match_count,b.original_match_sha256,m.subscription_id::text,m.binding_id::text FROM webhook_events e JOIN webhook_deliveries a ON a.event_id=e.id AND a.owner_kind='personal' JOIN webhook_deliveries b ON b.event_id=e.id AND b.owner_kind='team' JOIN webhook_delivery_matches m ON m.delivery_id=b.id`).Scan(&eventID, &eventAt, &eventRecorded, &fact, &eventHash, &originalFact, &first, &firstAt, &firstBody, &second, &secondAt, &secondBody, &target, &proofCount, &proofHash, &sub, &binding); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(fact)
	if !eventAt.Equal(at) || !eventRecorded.Equal(at) || !firstAt.Equal(at) || !secondAt.Equal(at) || !bytes.Equal(fact, firstBody) || !bytes.Equal(fact, secondBody) || !bytes.Equal(eventHash, digest[:]) || originalFact != int64(len(fact)) || proofCount != 1 {
		t.Fatal("source, fixed bytes, original hash, or proof mismatch")
	}
	// Controlled terminal activity is forty days old for one owner and twenty
	// days old for the other; both remain after the original Event occurrence.
	secondActivity := at.Add(20 * 24 * time.Hour)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='delivered',automatic_open=false,next_attempt_at=NULL,terminal_at=$2,last_activity_at=$2,metadata_expires_at=$2::timestamptz+interval '30 days' WHERE id=$1`, first, at); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='delivered',automatic_open=false,next_attempt_at=NULL,terminal_at=$2,last_activity_at=$2,metadata_expires_at=$2::timestamptz+interval '30 days' WHERE id=$1`, second, secondActivity); err != nil {
		t.Fatal(err)
	}
	gc := webhook.NewRetention(f.db)
	if _, _, err := gc.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var firstCount, secondCount, matches int
	var keptTarget, keptProof, keptHash, keptFact []byte
	var removed *time.Time
	var keptFactBytes int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE id=$1),(SELECT count(*) FROM webhook_deliveries WHERE id=$2),d.destination_ciphertext,d.original_match_sha256,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2 AND subscription_id=$3 AND binding_id=$4),e.fact_sha256,e.fact_bytes,e.fact_removed_at,e.original_fact_bytes FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$2 AND e.id=$5`, first, second, sub, binding, eventID).Scan(&firstCount, &secondCount, &keptTarget, &keptProof, &matches, &keptHash, &keptFact, &removed, &keptFactBytes); err != nil || firstCount != 0 || secondCount != 1 || matches != 1 || !bytes.Equal(keptTarget, target) || !bytes.Equal(keptProof, proofHash) || !bytes.Equal(keptHash, eventHash) || keptFact != nil || removed == nil || keptFactBytes != originalFact {
		t.Fatalf("first owner cleanup: first=%d second=%d proof=%d factRemoved=%v err=%v", firstCount, secondCount, matches, removed, err)
	}
	// Restart the component without advancing time: the remaining owner still
	// holds the Event and the exact original proof and target.
	gc = webhook.NewRetention(f.db)
	if _, _, err := gc.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	var remaining int
	var currentActivity time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*),max(d.last_activity_at) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE d.id=$1 AND e.id=$2 AND m.subscription_id=$3 AND m.binding_id=$4 AND d.destination_ciphertext=$5 AND d.original_match_sha256=$6 AND e.fact_sha256=$7`, second, eventID, sub, binding, target, proofHash, eventHash).Scan(&remaining, &currentActivity); err != nil || remaining != 1 || !currentActivity.Equal(secondActivity) {
		t.Fatalf("restart lost retained material: %d %v", remaining, err)
	}
	// A fresh maintenance component sees eleven days of controlled clock
	// advancement, crossing only the second owner's original activity deadline.
	gc = webhook.NewRetention(&sharedHistoryFutureStore{Store: f.db, advance: 11 * 24 * time.Hour})
	if _, _, err := gc.Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE id=$1)+(SELECT count(*) FROM webhook_deliveries WHERE event_id=$1)+(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2)`, eventID, second).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("last owner cleanup: %d %v", remaining, err)
	}
}
