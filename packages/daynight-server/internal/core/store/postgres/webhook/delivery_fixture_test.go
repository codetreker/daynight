package webhook

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type deliveryFailureFixture struct {
	conn                                    *pgx.Conn
	delivery, endpoint, user, team, project string
}

func newDeliveryFailureFixture(t *testing.T, conn *pgx.Conn) deliveryFailureFixture {
	t.Helper()
	ctx := context.Background()
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
		if _, err := conn.Exec(ctx, q.sql, q.args...); err != nil {
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
	ep := model.Endpoint{ID: endpoint, Owner: owner, Name: "receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationConfiguration: sampleDestination(), ActiveKeyID: key, CreatedAt: now, UpdatedAt: now}
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	if err = d.PutSigningKey(ctx, model.SigningKey{ID: key, EndpointID: endpoint, Slot: "current", Secret: sampleSecret(), CreatedAt: now}); err != nil {
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
	v := store.WebhookCapturedDelivery{ID: delivery, EndpointID: endpoint, Owner: owner, OriginalMatchSHA256: make([]byte, 32), PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: ep.Origin, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationConfiguration: ep.DestinationConfiguration, RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte(`[]`), Body: body, BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(168 * time.Hour), LastActivityAt: now, MetadataExpiresAt: now.Add(30 * 24 * time.Hour), Matches: []store.WebhookCapturedMatch{{SubscriptionID: sub, BindingID: binding, ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}}}
	if err = d.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{v}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return deliveryFailureFixture{conn, delivery, endpoint, user, team, project}
}
