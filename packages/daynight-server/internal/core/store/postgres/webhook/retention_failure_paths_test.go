package webhook

import (
	"context"
	"crypto/sha256"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRetentionDAOFailureAndDeletionBoundaries(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema, err := os.ReadFile("../schema/current.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	project, task, endpoint, delivery, eventID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	version := int64(1)
	fact, body := []byte(`{}`), []byte(`{"test":true}`)
	fh, bh := sha256.Sum256(fact), sha256.Sum256(body)
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	event := store.WebhookCapturedEvent{ID: eventID, EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + project, Subject: "tasks/" + task, ProjectID: project, TaskID: task, TaskVersion: &version, OccurredAt: now, RecordedAt: now, FactCodecVersion: 1, FactBytes: fact, FactSHA256: fh[:]}
	v := store.WebhookCapturedDelivery{ID: delivery, EndpointID: endpoint, Owner: model.Owner{Kind: "personal", ID: uuid.NewString()}, OriginalMatchSHA256: make([]byte, 32), PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: "https://example.test", RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationCiphertext: sampleEnvelope(t), RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte(`[]`), Body: body, BodySHA256: bh[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(168 * time.Hour), LastActivityAt: now, MetadataExpiresAt: now.Add(30 * 24 * time.Hour), Matches: []store.WebhookCapturedMatch{{SubscriptionID: uuid.NewString(), BindingID: uuid.NewString(), ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}}}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := New(tx)
	if err = dao.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{v}); err != nil {
		t.Fatal(err)
	}
	slot := int16(1)
	a := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: delivery, EndpointID: endpoint, Trigger: "automatic", LeaseToken: uuid.NewString(), Generation: 1, DestinationRevision: 1, Sequence: 1, SigningKeyIDs: []string{uuid.NewString()}, AutomaticPlanSlot: &slot, ClaimedAt: now, AdmittedAt: now}
	if err = dao.InsertAttempt(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		call func(*DAO) error
	}{
		{"extend invalid identity", func(d *DAO) error { _, e := d.ExtendRetention(ctx, "bad-uuid", now, now); return e }},
		{"payload invalid identity", func(d *DAO) error { _, e := d.RemoveExpiredPayload(ctx, "bad-uuid", now); return e }},
		{"delivery invalid identity", func(d *DAO) error { _, e := d.DeleteRetainedDelivery(ctx, "bad-uuid"); return e }},
		{"close invalid identity", func(d *DAO) error { _, e := d.CloseRetention(ctx, "bad-uuid", now); return e }},
		{"children invalid identity", func(d *DAO) error { _, e := d.DeleteRetentionChildren(ctx, "bad-uuid", 2); return e }},
		{"children invalid budget", func(d *DAO) error { _, e := d.DeleteRetentionChildren(ctx, delivery, 0); return e }},
		{"close missing delivery", func(d *DAO) error { _, e := d.CloseRetention(ctx, uuid.NewString(), now); return e }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, e := conn.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			if e = tc.call(New(tx)); e == nil {
				t.Fatal("expected failure")
			}
		})
	}

	t.Run("close rolls back if attempts unavailable", func(t *testing.T) {
		tx, e := conn.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, `ALTER TABLE webhook_attempts RENAME TO unavailable_attempts`); e != nil {
			t.Fatal(e)
		}
		if _, e = New(tx).CloseRetention(ctx, delivery, now); e == nil {
			t.Fatal("expected attempt update failure")
		}
		if e = tx.Rollback(ctx); e != nil {
			t.Fatal(e)
		}
		var purging bool
		if e = conn.QueryRow(ctx, `SELECT purging_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&purging); e != nil || purging {
			t.Fatalf("closing was not rolled back: %v %v", purging, e)
		}
	})
	t.Run("attempt delete failure", func(t *testing.T) {
		tx, e := conn.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, `ALTER TABLE webhook_attempts RENAME TO unavailable_attempts`); e != nil {
			t.Fatal(e)
		}
		if _, e = New(tx).DeleteRetentionChildren(ctx, uuid.NewString(), 2); e == nil {
			t.Fatal("expected attempt delete failure")
		}
	})
	t.Run("bounded children and closed attempts", func(t *testing.T) {
		tx, e := conn.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		if n, e := d.CloseRetention(ctx, delivery, now); e != nil || n != 2 {
			t.Fatalf("close=%d %v", n, e)
		}
		if n, e := d.DeleteRetainedDelivery(ctx, delivery); e != nil || n != 0 {
			t.Fatalf("deleted before children: %d %v", n, e)
		}
		if n, e := d.DeleteRetentionChildren(ctx, delivery, 1); e != nil || n != 1 {
			t.Fatalf("match batch: %d %v", n, e)
		}
		if n, e := d.DeleteRetentionChildren(ctx, delivery, 2); e != nil || n != 1 {
			t.Fatalf("attempt batch: %d %v", n, e)
		}
		if n, e := d.DeleteRetainedDelivery(ctx, delivery); e != nil || n != 1 {
			t.Fatalf("delivery: %d %v", n, e)
		}
	})
	t.Run("expired payload is idempotent", func(t *testing.T) {
		tx, e := conn.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		if n, e := d.ExtendRetention(ctx, delivery, now.Add(time.Hour), now.Add(31*24*time.Hour)); e != nil || n != 1 {
			t.Fatalf("extend %d %v", n, e)
		}
		if n, e := d.RemoveExpiredPayload(ctx, delivery, now); e != nil || n != 1 {
			t.Fatalf("clear %d %v", n, e)
		}
		if n, e := d.RemoveExpiredPayload(ctx, delivery, now); e != nil || n != 0 {
			t.Fatalf("repeat %d %v", n, e)
		}
	})
}
