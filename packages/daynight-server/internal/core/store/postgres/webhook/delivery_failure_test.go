package webhook

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type deliveryFailureFixture struct {
	conn                                    *pgx.Conn
	delivery, endpoint, user, team, project string
}

func newDeliveryFailureFixture(t *testing.T) deliveryFailureFixture {
	t.Helper()
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
	user, team, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO teams(id,name) VALUES($1,'team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'project','https://example.test')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'task')`, []any{task, project}},
	} {
		if _, err = conn.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d := New(tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	owner := model.Owner{Kind: "personal", ID: user}
	endpoint, key, sub, binding, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	ep := model.Endpoint{ID: endpoint, Owner: owner, Name: "receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationCiphertext: sampleEnvelope(t), ActiveKeyID: key, CreatedAt: now, UpdatedAt: now}
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	if err = d.PutSigningKey(ctx, model.SigningKey{ID: key, EndpointID: endpoint, Slot: "current", Ciphertext: sampleEnvelope(t), CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err = d.PutSubscription(ctx, model.Subscription{ID: sub, EndpointID: endpoint, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err = d.PutBinding(ctx, model.Binding{ID: binding, SubscriptionID: sub, EventType: "task.created", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	body, fact := []byte(`{}`), []byte(`{}`)
	bodyHash, factHash := sha256.Sum256(body), sha256.Sum256(fact)
	version := int64(1)
	event := store.WebhookCapturedEvent{ID: uuid.NewString(), EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + project, Subject: "tasks/" + task, ProjectID: project, TaskID: task, TaskVersion: &version, OccurredAt: now, RecordedAt: now, FactCodecVersion: 1, FactBytes: fact, FactSHA256: factHash[:]}
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	v := store.WebhookCapturedDelivery{ID: delivery, EndpointID: endpoint, Owner: owner, OriginalMatchSHA256: make([]byte, 32), PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: ep.Origin, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationCiphertext: ep.DestinationCiphertext, RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte(`[]`), Body: body, BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(168 * time.Hour), LastActivityAt: now, MetadataExpiresAt: now.Add(30 * 24 * time.Hour), Matches: []store.WebhookCapturedMatch{{SubscriptionID: sub, BindingID: binding, ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}}}
	if err = d.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{v}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return deliveryFailureFixture{conn, delivery, endpoint, user, team, project}
}

func TestDeliveryDAOFailureAndBoundaryPaths(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	t.Run("cancelled clock", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err = New(tx).ObservedAt(cancelled)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("clock cancellation: %v", err)
		}
	})
	t.Run("expiry batch bounds and query failure", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		for _, limit := range []int{0, 9} {
			if _, err = d.LockExpired(ctx, limit, now); err == nil {
				t.Fatalf("accepted batch size %d", limit)
			}
		}
		if _, err = tx.Exec(ctx, `ALTER TABLE webhook_deliveries RENAME TO inaccessible_deliveries`); err != nil {
			t.Fatal(err)
		}
		_, err = d.LockExpired(ctx, 1, now)
		assertMissingRelation(t, err)
	})
	t.Run("select expired work", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds',lease_generation=generation WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		rows, err := New(tx).LockExpired(ctx, 1, time.Now())
		if err != nil || len(rows) != 1 || rows[0].ID != f.delivery {
			t.Fatalf("expired lease rows=%+v err=%v", rows, err)
		}
		if err = tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		tx, err = f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		rows, err = New(tx).LockDueExpiry(ctx, 1, time.Now())
		if err != nil || len(rows) != 1 || rows[0].ID != f.delivery {
			t.Fatalf("expired pending rows=%+v err=%v", rows, err)
		}
	})
	t.Run("invalid selected id", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = New(tx).lockDeliveryIDs(ctx, `SELECT NULL::text WHERE $1::timestamptz IS NOT NULL LIMIT $2`, 1, now)
		if err == nil {
			t.Fatal("null selected identity accepted")
		}
	})
	t.Run("wait missing and storage failure", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		if err = d.RaiseWait(ctx, uuid.NewString(), 1, now.Add(time.Minute), now); err == nil {
			t.Fatal("missing wait accepted")
		}
		if _, err = tx.Exec(ctx, `ALTER TABLE webhook_endpoint_waits RENAME TO inaccessible_waits`); err != nil {
			t.Fatal(err)
		}
		assertMissingRelation(t, d.RaiseWait(ctx, f.endpoint, 1, now.Add(time.Minute), now))
	})
	t.Run("purging and invalid delivery state", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		v, err := d.LockDelivery(ctx, f.delivery)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		if err = d.UpdateDelivery(ctx, v); err == nil {
			t.Fatal("purging delivery accepted update")
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=NULL WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		v.State = "invalid"
		err = d.UpdateDelivery(ctx, v)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("invalid state error %v", err)
		}
	})
}

func assertMissingRelation(t *testing.T, err error) {
	t.Helper()
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || failure.Code != "42P01" {
		t.Fatalf("expected database missing-relation failure, got %v", err)
	}
}

func TestAdmissionSourcesDatabaseFailures(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := context.Background()
	now := time.Now()
	// Each savepoint hides one actual PostgreSQL relation. An internal read
	// failure must propagate, not be interpreted as revoked authorization.
	for _, table := range []string{"webhook_deliveries", "tasks", "project_ownership", "teams", "team_members", "project_grants", "users", "projects", "webhook_endpoints", "webhook_signing_keys", "webhook_delivery_matches", "webhook_subscriptions", "webhook_bindings"} {
		t.Run(table, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `ALTER TABLE `+pgx.Identifier{table}.Sanitize()+` RENAME TO hidden_relation`); err != nil {
				t.Fatal(err)
			}
			_, err = New(tx).AdmissionSources(ctx, f.delivery, now)
			assertMissingRelation(t, err)
		})
	}
}
