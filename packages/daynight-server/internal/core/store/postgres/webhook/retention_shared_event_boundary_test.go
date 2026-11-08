package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type retentionStorageFixture struct {
	conn       *pgx.Conn
	event      string
	deliveries []string
	fact, hash []byte
	proof      []byte
}

func newRetentionStorageFixture(t *testing.T, owners, matches, attempts int) retentionStorageFixture {
	t.Helper()
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	event, original := captureBoundaryRecords(t, ctx, tx, f.delivery, 2)
	if _, err = tx.Exec(ctx, `DELETE FROM webhook_delivery_matches WHERE delivery_id=$1`, f.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM webhook_deliveries WHERE id=$1`, f.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM webhook_events WHERE id=$1`, event.ID); err != nil {
		t.Fatal(err)
	}
	event.ID = uuid.NewString()
	at := time.Now().UTC().Add(-40 * 24 * time.Hour).Truncate(time.Microsecond)
	event.OccurredAt, event.RecordedAt = at, at
	fact := bytes.Clone(event.FactBytes)
	hash := sha256.Sum256(fact)
	event.FactSHA256 = hash[:]
	proof := sha256.Sum256([]byte("original retained match proof"))
	prepared := make([]store.WebhookCapturedDelivery, owners)
	for i := range prepared {
		delivery := original
		delivery.ID = uuid.NewString()
		delivery.Body, delivery.BodySHA256, delivery.OriginalMatchSHA256 = fact, hash[:], proof[:]
		delivery.AutomaticScheduleAt = make([]time.Time, 10)
		for j := range delivery.AutomaticScheduleAt {
			delivery.AutomaticScheduleAt[j] = at.Add(time.Duration(j) * time.Minute)
		}
		delivery.AutomaticExpiresAt, delivery.PayloadExpiresAt = at.Add(72*time.Hour), at.Add(168*time.Hour)
		delivery.LastActivityAt, delivery.MetadataExpiresAt = at, at.Add(30*24*time.Hour)
		if i != 0 {
			delivery.Owner = wm.Owner{Kind: "team", ID: f.team}
			delivery.EndpointID = uuid.NewString()
			ep := wm.Endpoint{ID: delivery.EndpointID, Owner: delivery.Owner, Name: "retained team receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationConfiguration: sampleDestination(), ActiveKeyID: uuid.NewString(), CreatedAt: at, UpdatedAt: at}
			if err = New(tx).PutEndpoint(ctx, ep); err != nil {
				t.Fatal(err)
			}
		}
		delivery.Matches = make([]store.WebhookCapturedMatch, matches)
		for j := range delivery.Matches {
			delivery.Matches[j] = store.WebhookCapturedMatch{SubscriptionID: uuid.NewString(), BindingID: uuid.NewString(), ProjectID: f.project, EventType: event.EventType, AuthorizationEpoch: 1}
		}
		prepared[i] = delivery
	}
	if err = New(tx).SaveCapture(ctx, event, prepared); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(prepared))
	for i, d := range prepared {
		ids[i] = d.ID
		for j := 0; j < attempts; j++ {
			slot := int16(j + 1)
			a := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: d.ID, EndpointID: d.EndpointID, Trigger: "automatic", LeaseToken: uuid.NewString(), Generation: 1, DestinationRevision: 1, Sequence: slot, SigningKeyIDs: []string{uuid.NewString()}, AutomaticPlanSlot: &slot, ClaimedAt: at, AdmittedAt: at}
			if err = New(tx).InsertAttempt(ctx, a); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return retentionStorageFixture{conn: f.conn, event: event.ID, deliveries: ids, fact: fact, hash: hash[:], proof: proof[:]}
}

func TestSharedEventRetentionWaitsForEveryOwnerReference(t *testing.T) {
	f := newRetentionStorageFixture(t, 2, 1, 0)
	ctx := t.Context()
	first, second := f.deliveries[0], f.deliveries[1]
	if _, err := f.conn.Exec(ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL WHERE id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=$2,lease_claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds',lease_generation=generation WHERE id=$1`, second, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := New(tx)
	if n, err := dao.RemoveExpiredPayload(ctx, first, time.Now()); err != nil || n != 1 {
		t.Fatalf("first payload removal: %d %v", n, err)
	}
	if id, n, err := dao.ClearExpiredEvent(ctx); err != nil || n != 0 || id != "" {
		t.Fatalf("shared live body lost original fact: %s %d %v", id, n, err)
	}
	if id, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 0 || id != "" {
		t.Fatalf("referenced shared event deleted: %s %d %v", id, n, err)
	}
	if n, err := dao.CloseRetention(ctx, first, time.Now()); err != nil || n != 1 {
		t.Fatalf("first closure: %d %v", n, err)
	}
	if n, err := dao.DeleteRetentionChildren(ctx, first, 500); err != nil || n != 1 {
		t.Fatalf("first children: %d %v", n, err)
	}
	if n, err := dao.DeleteRetainedDelivery(ctx, first); err != nil || n != 1 {
		t.Fatalf("first delivery: %d %v", n, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// A fresh connection observes retained material without a component cursor.
	reader, err := pgx.Connect(ctx, f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	var fact, hash, body, proof []byte
	var originalFact, originalMatches, liveMatches int
	var live bool
	if err = reader.QueryRow(ctx, `SELECT e.fact_bytes,e.fact_sha256,e.original_fact_bytes,d.body,d.original_match_sha256,d.original_match_count,d.lease_until>clock_timestamp(),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.id=$1 AND d.id=$2`, f.event, second).Scan(&fact, &hash, &originalFact, &body, &proof, &originalMatches, &live, &liveMatches); err != nil || !bytes.Equal(fact, f.fact) || !bytes.Equal(hash, f.hash) || originalFact != len(f.fact) || !bytes.Equal(body, f.fact) || !bytes.Equal(proof, f.proof) || originalMatches != 1 || liveMatches != 1 || !live {
		t.Fatalf("fresh shared owner witness: live=%v matches=%d/%d error=%v", live, liveMatches, originalMatches, err)
	}
	tx, err = reader.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao = New(tx)
	if _, found, err := dao.LockRetentionCandidate(ctx, "payload", time.Now()); err != nil || found {
		t.Fatalf("live owner payload selected: %v %v", found, err)
	}
	if id, n, err := dao.ClearExpiredEvent(ctx); err != nil || n != 0 || id != "" {
		t.Fatalf("fresh DAO cleared live shared fact: %s %d %v", id, n, err)
	}
	if id, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 0 || id != "" {
		t.Fatalf("fresh DAO deleted shared metadata: %s %d %v", id, n, err)
	}
	row, err := dao.LockDelivery(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	row.State, row.AutomaticOpen, row.NextAttemptAt = "failed", false, nil
	row.LeaseToken, row.LeaseClaimedAt, row.LeaseUntil, row.LeaseGeneration, row.LeasePlanSlot, row.CurrentAttemptID = nil, nil, nil, nil, nil, nil
	if err = dao.UpdateDelivery(ctx, row); err != nil {
		t.Fatal(err)
	}
	if n, err := dao.RemoveExpiredPayload(ctx, second, time.Now()); err != nil || n != 1 {
		t.Fatalf("last payload removal: %d %v", n, err)
	}
	if id, n, err := dao.ClearExpiredEvent(ctx); err != nil || n != 1 || id != f.event {
		t.Fatalf("unneeded shared fact remained: %s %d %v", id, n, err)
	}
	if id, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 0 || id != "" {
		t.Fatalf("fact clear deleted retained metadata reference: %s %d %v", id, n, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var factRemoved bool
	if err = f.conn.QueryRow(ctx, `SELECT fact_bytes IS NULL AND fact_removed_at IS NOT NULL,fact_sha256,original_fact_bytes FROM webhook_events WHERE id=$1`, f.event).Scan(&factRemoved, &hash, &originalFact); err != nil || !factRemoved || !bytes.Equal(hash, f.hash) || originalFact != len(f.fact) {
		t.Fatalf("cleared fact lost original immutable accounting: %v %v", factRemoved, err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao = New(tx)
	if n, err := dao.CloseRetention(ctx, second, time.Now()); err != nil || n != 1 {
		t.Fatalf("last closure: %d %v", n, err)
	}
	if n, err := dao.DeleteRetentionChildren(ctx, second, 500); err != nil || n != 1 {
		t.Fatalf("last children: %d %v", n, err)
	}
	if n, err := dao.DeleteRetainedDelivery(ctx, second); err != nil || n != 1 {
		t.Fatalf("last delivery removal: %d %v", n, err)
	}
	if id, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 1 || id != f.event {
		t.Fatalf("last reference did not release event: %s %d %v", id, n, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err = reader.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE id=$1)+(SELECT count(*) FROM webhook_deliveries WHERE event_id=$1)`, f.event).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("final shared references remained: %d %v", remaining, err)
	}
}
