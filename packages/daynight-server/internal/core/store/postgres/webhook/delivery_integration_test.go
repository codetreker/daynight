package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type waitBarrier struct {
	once             sync.Once
	entered, release chan struct{}
	prefix           string
}

func (b *waitBarrier) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, b.prefix) {
		b.once.Do(func() {
			close(b.entered)
			select {
			case <-b.release:
			case <-ctx.Done():
			}
		})
	}
	return ctx
}
func (*waitBarrier) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type claimResult struct {
	rows []store.WebhookDelivery
	err  error
}

func blockedClaim(ctx context.Context, url string, limit int, now time.Time, tokens []string, prefix string) (*waitBarrier, <-chan claimResult, error) {
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, nil, err
	}
	b := &waitBarrier{entered: make(chan struct{}), release: make(chan struct{}), prefix: prefix}
	config.Tracer = b
	c, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, nil, err
	}
	results := make(chan claimResult, 1)
	go func() {
		defer c.Close(context.Background())
		tx, e := c.Begin(ctx)
		if e != nil {
			results <- claimResult{err: e}
			return
		}
		defer tx.Rollback(context.Background())
		rows, e := New(tx).Claim(ctx, limit, now, tokens)
		if e == nil {
			e = tx.Commit(ctx)
		}
		results <- claimResult{rows, e}
	}()
	return b, results, nil
}

func TestDeliveryClaimFIFOAndWait(t *testing.T) {
	ctx := context.Background()
	url := testutil.ScopedDatabaseURL(t)
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	schema, err := os.ReadFile("../schema/current.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	d := New(tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	occurred := now.Add(-time.Minute)
	owner := model.Owner{Kind: "personal", ID: uuid.NewString()}
	project, task := uuid.NewString(), uuid.NewString()
	var ids, endpointIDs []string
	for i := 0; i < 5; i++ {
		endpoint := model.Endpoint{ID: uuid.NewString(), Owner: owner, Name: "endpoint", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationConfiguration: sampleDestination(), ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
		if err = d.PutEndpoint(ctx, endpoint); err != nil {
			t.Fatal(err)
		}
		endpointIDs = append(endpointIDs, endpoint.ID)
		eventID, deliveryID := uuid.NewString(), uuid.NewString()
		ids = append(ids, deliveryID)
		fact, body := []byte(`{}`), []byte(`{"test":true}`)
		factHash, bodyHash := sha256.Sum256(fact), sha256.Sum256(body)
		version := int64(1)
		event := store.WebhookCapturedEvent{ID: eventID, EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + project, Subject: "tasks/" + task, ProjectID: project, TaskID: task, TaskVersion: &version, OccurredAt: occurred, RecordedAt: now, FactCodecVersion: 1, FactBytes: fact, FactSHA256: factHash[:]}
		schedule := make([]time.Time, 10)
		for j := range schedule {
			schedule[j] = occurred.Add(time.Duration(j) * time.Minute)
		}
		v := store.WebhookCapturedDelivery{ID: deliveryID, EndpointID: endpoint.ID, Owner: owner, OriginalMatchSHA256: make([]byte, 32), PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: endpoint.Origin, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationConfiguration: endpoint.DestinationConfiguration, RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte(`[]`), Body: body, BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: occurred.Add(72 * time.Hour), PayloadExpiresAt: occurred.Add(168 * time.Hour), LastActivityAt: now, MetadataExpiresAt: now.Add(30 * 24 * time.Hour), Matches: []store.WebhookCapturedMatch{{SubscriptionID: uuid.NewString(), BindingID: uuid.NewString(), ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}}}
		if err = d.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{v}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=$1 WHERE endpoint_id=ANY($2::uuid[])`, now.Add(time.Hour), endpointIDs[:2]); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	locker, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close(ctx)
	locked, err := locker.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(ctx)
	if _, err = locked.Exec(ctx, `SELECT id FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, ids[2]); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	d = New(tx)
	tokens := []string{uuid.NewString(), uuid.NewString()}
	claimed, err := d.Claim(ctx, 2, now, tokens)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 2 || claimed[0].ID != ids[3] || claimed[1].ID != ids[4] || *claimed[0].LeaseToken != tokens[0] || claimed[0].LeaseUntil.Sub(*claimed[0].LeaseClaimedAt) != 45*time.Second {
		t.Fatalf("unexpected claim: %+v", claimed)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = locked.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// Pause after the candidate Delivery lock, advance its Wait in another
	// transaction, then prove the claim fills its batch from later tickets.
	if _, err = conn.Exec(ctx, `UPDATE webhook_deliveries SET state='pending',next_attempt_at=occurred_at,lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=NULL`); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	barrier, results, err := blockedClaim(bounded, url, 2, time.Now(), []string{uuid.NewString(), uuid.NewString()}, "SELECT not_before FROM webhook_endpoint_waits")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-barrier.entered:
	case <-bounded.Done():
		t.Fatal("claim did not reach locked candidate")
	}
	if _, err = conn.Exec(bounded, `UPDATE webhook_endpoint_waits SET not_before=$2 WHERE endpoint_id=$1`, endpointIDs[0], now.Add(time.Hour)); err != nil {
		close(barrier.release)
		t.Fatal(err)
	}
	close(barrier.release)
	result := <-results
	if result.err != nil || len(result.rows) != 2 || result.rows[0].ID != ids[1] || result.rows[1].ID != ids[2] {
		t.Fatalf("claim after wait advanced: %+v, %v", result.rows, result.err)
	}
	var postponed time.Time
	if err = conn.QueryRow(ctx, `SELECT next_attempt_at FROM webhook_deliveries WHERE id=$1`, ids[0]).Scan(&postponed); err != nil || !postponed.Equal(now.Add(time.Hour)) {
		t.Fatalf("candidate not postponed: %v, %v", postponed, err)
	}

	// Two transactions race for a single executable Delivery. The second
	// skips the locked row and cannot acquire a second token.
	if _, err = conn.Exec(ctx, `UPDATE webhook_deliveries SET state='pending',next_attempt_at=occurred_at,lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=$1 WHERE endpoint_id<>$2`, now.Add(time.Hour), endpointIDs[2]); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=NULL WHERE endpoint_id=$1`, endpointIDs[2]); err != nil {
		t.Fatal(err)
	}
	token := uuid.NewString()
	barrier, results, err = blockedClaim(bounded, url, 1, time.Now(), []string{token}, "SELECT not_before FROM webhook_endpoint_waits")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-barrier.entered:
	case <-bounded.Done():
		t.Fatal("first claimant did not acquire row")
	}
	tx, err = conn.Begin(bounded)
	if err != nil {
		close(barrier.release)
		t.Fatal(err)
	}
	if _, acquired, err := New(tx).TryLockDelivery(bounded, ids[2]); err != nil || acquired {
		close(barrier.release)
		t.Fatalf("try-lock contention: acquired=%v err=%v", acquired, err)
	}
	second, err := New(tx).Claim(bounded, 1, time.Now(), []string{uuid.NewString()})
	if err != nil {
		close(barrier.release)
		t.Fatal(err)
	}
	if err = tx.Commit(bounded); err != nil {
		close(barrier.release)
		t.Fatal(err)
	}
	close(barrier.release)
	result = <-results
	if result.err != nil || len(result.rows) != 1 || result.rows[0].ID != ids[2] || len(second) != 0 {
		t.Fatalf("competing claims: first=%+v second=%+v err=%v", result.rows, second, result.err)
	}
	var savedToken string
	if err = conn.QueryRow(ctx, `SELECT lease_token::text FROM webhook_deliveries WHERE id=$1`, ids[2]).Scan(&savedToken); err != nil || savedToken != token {
		t.Fatalf("stored token=%s err=%v", savedToken, err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	d = New(tx)
	active, err := d.LockDelivery(ctx, ids[2])
	if err != nil {
		t.Fatal(err)
	}
	slot := int16(1)
	attempt := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: active.ID, EndpointID: active.EndpointID, Trigger: "automatic", LeaseToken: token, Generation: active.Generation, DestinationRevision: active.DestinationRevision, Sequence: 1, SigningKeyIDs: []string{uuid.NewString()}, AutomaticPlanSlot: &slot, ClaimedAt: *active.LeaseClaimedAt, AdmittedAt: now}
	if err = d.InsertAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	configuration, body, proof := bytes.Clone(active.DestinationConfiguration), bytes.Clone(active.Body), bytes.Clone(active.OriginalMatchSHA256)
	active.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://replacement.example/hook"}}`)
	active.Body, active.OriginalMatchSHA256 = []byte(`{"replaced":true}`), bytes.Repeat([]byte{1}, 32)
	active.AttemptSequence, active.AutomaticAttemptCount, active.LeasePlanSlot, active.CurrentAttemptID = 1, 1, &slot, &attempt.ID
	if err = d.UpdateDelivery(ctx, active); err != nil {
		t.Fatal(err)
	}
	stored, err := d.LockDelivery(ctx, active.ID)
	if err != nil || !bytes.Equal(stored.DestinationConfiguration, configuration) || !bytes.Equal(stored.Body, body) || !bytes.Equal(stored.OriginalMatchSHA256, proof) || stored.AttemptSequence != 1 {
		t.Fatalf("control update changed immutable capture data: %+v, %v", stored, err)
	}
	attempts, err := d.LockAttempts(ctx, active.ID)
	if err != nil || len(attempts) != 1 || attempts[0].ID != attempt.ID || len(attempts[0].SigningKeyIDs) != 1 {
		t.Fatalf("attempt scan=%+v err=%v", attempts, err)
	}
	unknown := "unknown"
	attempt.FinishedAt, attempt.RecoveredUnknownAt, attempt.Outcome = &now, &now, &unknown
	if err = d.UpdateAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = d.LockWait(ctx, active.EndpointID, active.DestinationRevision); err != nil {
		t.Fatal(err)
	}
	if err = d.RaiseWait(ctx, active.EndpointID, active.DestinationRevision, now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	if err = d.RaiseWait(ctx, active.EndpointID, active.DestinationRevision, now.Add(time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var waitUntil time.Time
	if err = conn.QueryRow(ctx, `SELECT not_before FROM webhook_endpoint_waits WHERE endpoint_id=$1`, active.EndpointID).Scan(&waitUntil); err != nil || !waitUntil.Equal(now.Add(time.Hour)) {
		t.Fatalf("wait not monotonic: %v, %v", waitUntil, err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	late, err := New(tx).LockOwnAttempt(ctx, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	ack := "acknowledged"
	late.LateObservedAt, late.LateOutcome = &now, &ack
	if err = New(tx).UpdateAttempt(ctx, late); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_attempts SET retention_closed_at=$2 WHERE id=$1`, attempt.ID, now); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	late, err = New(tx).LockOwnAttempt(ctx, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = New(tx).UpdateAttempt(ctx, late); err == nil {
		t.Fatal("closed attempt accepted late write")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// An opportunity can expire after selection but before the locked-row
	// recheck. The fresh database clock must skip it and reach the next ticket.
	if _, err = conn.Exec(ctx, `UPDATE webhook_deliveries SET state='pending',next_attempt_at=occurred_at,lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=NULL`); err != nil {
		t.Fatal(err)
	}
	var expiry time.Time
	if err = conn.QueryRow(ctx, `UPDATE webhook_deliveries SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at`, ids[0]).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	expiryCtx, expiryCancel := context.WithTimeout(ctx, 5*time.Second)
	defer expiryCancel()
	barrier, results, err = blockedClaim(expiryCtx, url, 1, time.Now(), []string{uuid.NewString()}, "SELECT clock_timestamp()")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-barrier.entered:
	case <-expiryCtx.Done():
		t.Fatal("claim did not lock expiring candidate")
	}
	for {
		var expired bool
		if err = conn.QueryRow(expiryCtx, `SELECT clock_timestamp()>=$1`, expiry).Scan(&expired); err != nil {
			close(barrier.release)
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-expiryCtx.Done():
			close(barrier.release)
			t.Fatal("database clock did not advance")
		case <-time.After(10 * time.Millisecond):
		}
	}
	close(barrier.release)
	result = <-results
	if result.err != nil || len(result.rows) != 1 || result.rows[0].ID != ids[1] {
		t.Fatalf("claim after expiry: %+v, %v", result.rows, result.err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=$1 WHERE endpoint_id<>$2`, now.Add(time.Hour), endpointIDs[2]); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE webhook_deliveries SET state='pending',next_attempt_at=occurred_at,lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL WHERE id=$1`, ids[2]); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `DELETE FROM webhook_endpoint_waits WHERE endpoint_id=$1`, endpointIDs[2]); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = New(tx).Claim(ctx, 1, now, []string{uuid.NewString()}); err == nil {
		t.Fatal("missing current wait was accepted")
	}
}
