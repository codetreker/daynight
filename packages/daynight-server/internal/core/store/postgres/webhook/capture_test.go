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
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaptureAudienceAndPersistence(t *testing.T) {
	ctx := context.Background()
	databaseURL := testutil.ScopedDatabaseURL(t)
	conn, err := pgx.Connect(ctx, databaseURL)
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
	projectID, userID, teamID, taskID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{userID, "capture:" + userID}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, []any{teamID, userID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, userID}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'capture','capture')`, []any{projectID}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{projectID, teamID}},
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
	env, err := (secretbox.Envelope{Version: 1, MasterKeyID: "primary", Nonce: make([]byte, 12), Ciphertext: make([]byte, 32)}).MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	ep := model.Endpoint{ID: uuid.NewString(), Owner: model.Owner{Kind: "personal", ID: userID}, Name: "endpoint", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationCiphertext: env, ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 51; i++ {
		subID := uuid.NewString()
		sub := model.Subscription{ID: subID, EndpointID: ep.ID, ProjectID: projectID, Owner: ep.Owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
		if err = d.PutSubscription(ctx, sub); err != nil {
			t.Fatal(err)
		}
		if err = d.PutBinding(ctx, model.Binding{ID: uuid.NewString(), SubscriptionID: subID, EventType: "task.created", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d = New(tx)
	if _, err = NewProjectCapture(tx, projectID).FreezeAudience(ctx, uuid.NewString(), []string{"task.created"}); err == nil {
		t.Fatal("accepted an audience for another project")
	}
	audience, err := d.FreezeAudience(ctx, projectID, []string{"task.created", "task.paused"})
	if err != nil {
		t.Fatal(err)
	}
	if len(audience) != 51 {
		t.Fatalf("got %d matches", len(audience))
	}
	for _, a := range audience {
		if a.EventType != "task.created" || a.Endpoint.ID != ep.ID || a.ProjectID != projectID || a.AuthorizationEpoch != 1 {
			t.Fatalf("unexpected audience: %+v", a)
		}
	}
	other, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(ctx)
	if _, err = other.Exec(ctx, `UPDATE webhook_endpoints SET enabled=false,destination_revision=2 WHERE id=$1`, ep.ID); err != nil {
		t.Fatal(err)
	}
	later, err := d.FreezeAudience(ctx, projectID, []string{"task.created"})
	if err != nil || len(later) != 0 {
		t.Fatalf("new snapshot audience=%+v err=%v", later, err)
	}
	if audience[0].Endpoint.DestinationRevision != 1 {
		t.Fatalf("frozen destination changed: %+v", audience[0].Endpoint)
	}
	policy, err := d.Policy(ctx, 1)
	if err != nil || policy.Version != 1 {
		t.Fatalf("policy=%+v err=%v", policy, err)
	}
	recorded, err := d.RecordedAt(ctx)
	if err != nil || recorded.IsZero() {
		t.Fatalf("recorded=%v err=%v", recorded, err)
	}
	fact := []byte(`{"projectId":"` + projectID + `"}`)
	body := []byte(`{"specversion":"1.0"}`)
	factHash, bodyHash := sha256.Sum256(fact), sha256.Sum256(body)
	version := int64(1)
	event := store.WebhookCapturedEvent{ID: uuid.NewString(), EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + projectID, Subject: "tasks/" + taskID, ProjectID: projectID, TaskID: taskID, TaskVersion: &version, OccurredAt: now, RecordedAt: recorded, FactCodecVersion: 1, FactBytes: fact, FactSHA256: factHash[:]}
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	matches := make([]store.WebhookCapturedMatch, 0, len(audience))
	for _, a := range audience {
		matches = append(matches, store.WebhookCapturedMatch{SubscriptionID: a.SubscriptionID, BindingID: a.BindingID, ProjectID: a.ProjectID, EventType: a.EventType, AuthorizationEpoch: a.AuthorizationEpoch})
	}
	proof := sha256.Sum256([]byte("proof"))
	delivery := store.WebhookCapturedDelivery{ID: uuid.NewString(), EndpointID: ep.ID, Owner: ep.Owner, OriginalMatchSHA256: proof[:], PolicyVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: 1, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationOrigin: ep.Origin, DestinationCiphertext: env, RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte("[]"), Body: body, BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(7 * 24 * time.Hour), LastActivityAt: recorded, MetadataExpiresAt: recorded.Add(30 * 24 * time.Hour), Matches: matches}
	if err = d.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery}); err != nil {
		t.Fatal(err)
	}
	var count int64
	var queue int64
	if err = tx.QueryRow(ctx, `SELECT original_match_count,queue_order FROM webhook_deliveries WHERE id=$1`, delivery.ID).Scan(&count, &queue); err != nil {
		t.Fatal(err)
	}
	if count != 51 || queue <= 0 {
		t.Fatalf("count=%d queue=%d", count, queue)
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$1`, delivery.ID).Scan(&count); err != nil || count != 51 {
		t.Fatalf("persisted matches=%d err=%v", count, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// A failed match insert aborts the event and delivery alongside source writes.
	tx2, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx2.Rollback(ctx)
	event.ID = uuid.NewString()
	delivery.ID = uuid.NewString()
	delivery.Matches = append(delivery.Matches, delivery.Matches[0])
	if err = New(tx2).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery}); err == nil {
		t.Fatal("duplicate match accepted")
	}
	if err = tx2.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM webhook_events WHERE id=$1`, event.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed event count=%d err=%v", count, err)
	}
}
