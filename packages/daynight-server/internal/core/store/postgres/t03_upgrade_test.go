package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	migration026 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal/migration026"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestT03PopulatedT02UpgradeAndSourceCapture(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if len(schemaMigrations) != 50 || schemaMigrations[48].version != 49 || schemaMigrations[49].version != 50 {
		t.Fatal("unexpected migration boundary")
	}
	if err = migrate(ctx, pool, schemaMigrations[:49]); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(migration026.TransformSource()))
	if fmt.Sprintf("%x", digest) != "2e3c075680247546672293a9d32fb66dee88983b3d0f601f5b4d3fe6144f5f05" {
		t.Fatalf("migration 026 source changed: %x", digest)
	}
	user, session, team, project, oldTask := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, token[:]}},
		{`INSERT INTO teams(id,name) VALUES($1,'existing team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'existing project','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title,description,version) VALUES($1,$2,'existing task','unchanged',9007199254740993)`, []any{oldTask, project}},
	} {
		if _, err = pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + encoded + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	oldStore := &Store{Pool: pool}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	manager := &webhook.Service{DB: oldStore, Keys: keys, ConfigurationExpansionAvailable: true}
	name, enabled := "receiver", true
	request := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: user, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}}
	if _, err = manager.Mutate(ctx, principal, webhook.Owner{Kind: "personal", ID: user}, request); err != nil {
		t.Fatal(err)
	}
	var originalSubscription, originalBinding string
	var originalEpoch int64
	if err = pool.QueryRow(ctx, `SELECT s.id::text,b.id::text,s.authorization_epoch FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE s.project_id=$1 AND b.event_type='task.created'`, project).Scan(&originalSubscription, &originalBinding, &originalEpoch); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var value string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=49),
 'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$1),
 'endpoints',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_endpoints e),
 'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM webhook_signing_keys k),
 'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM webhook_subscriptions s),
 'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM webhook_bindings b),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY version) FROM webhook_policies p))::text`, oldTask).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	upgraded, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	if after := snapshot(); after != before {
		t.Fatalf("T02 data or old ledger changed: before=%s after=%s", before, after)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 50 {
		t.Fatalf("migration count=%d err=%v", count, err)
	}
	for _, index := range []string{"webhook_deliveries_due", "webhook_deliveries_fifo", "webhook_deliveries_event", "webhook_deliveries_endpoint_revision", "webhook_deliveries_metadata_expiry", "webhook_deliveries_purging", "webhook_delivery_matches_subscription", "webhook_delivery_matches_binding"} {
		var valid bool
		err = pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1 AND i.indisvalid AND i.indisready)`, index).Scan(&valid)
		if err != nil || !valid {
			t.Fatalf("index %s missing: %v", index, err)
		}
	}
	var defaultExpr string
	if err = pool.QueryRow(ctx, `SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='webhook_deliveries'::regclass AND a.attname='queue_order'`).Scan(&defaultExpr); err != nil || !strings.Contains(defaultExpr, "webhook_delivery_queue_order_seq") {
		t.Fatalf("queue default %q: %v", defaultExpr, err)
	}
	tasks := taskservice.NewTasks(upgraded, &webhook.Capturer{Keys: keys})
	var previous int64
	for n := 0; n < 2; n++ {
		created, err := tasks.Create(ctx, principal, project, taskcore.CreateTask{Title: fmt.Sprintf("after upgrade %d", n)})
		if err != nil {
			t.Fatal(err)
		}
		var queue, matchCount, actualMatches int64
		var version int64
		var eventID, deliveryID string
		var body, bodyHash, fact, factHash, matchHash []byte
		err = upgraded.Pool.QueryRow(ctx, `SELECT d.queue_order,d.original_match_count,(SELECT count(*) FROM webhook_delivery_matches m WHERE m.delivery_id=d.id),e.task_version,e.id::text,d.id::text,d.body,d.body_sha256,e.fact_bytes,e.fact_sha256,d.original_match_sha256 FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, created.ID).Scan(&queue, &matchCount, &actualMatches, &version, &eventID, &deliveryID, &body, &bodyHash, &fact, &factHash, &matchHash)
		if err != nil || queue <= previous || matchCount != 1 || actualMatches != 1 || version != created.Version {
			t.Fatalf("capture queue=%d matches=%d/%d version=%d err=%v", queue, matchCount, actualMatches, version, err)
		}
		// Build the wire oracle from the persisted source, without the renderer.
		wantBody := fmt.Sprintf(`{"specversion":"1.0","id":"%s","source":"urn:daynight:project:%s","type":"cc.daynight.task.created.v1","subject":"tasks/%s","time":"%s","datacontenttype":"application/json","data":{"projectId":"%s","taskId":"%s","taskVersion":"%d","status":"todo","paused":false}}`, eventID, project, created.ID, created.CreatedAt.UTC().Format(time.RFC3339Nano), project, created.ID, created.Version)
		bodyDigest := sha256.Sum256([]byte(wantBody))
		if !bytes.Equal(body, []byte(wantBody)) || !bytes.Equal(bodyHash, bodyDigest[:]) || !bytes.Equal(fact, []byte(wantBody)) || !bytes.Equal(factHash, bodyDigest[:]) {
			t.Fatalf("captured wire bytes or digest differ: got %s want %s", body, wantBody)
		}
		var subscription, binding, matchProject, eventType string
		var epoch int64
		if err = upgraded.Pool.QueryRow(ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, deliveryID).Scan(&subscription, &binding, &matchProject, &eventType, &epoch); err != nil {
			t.Fatal(err)
		}
		if subscription != originalSubscription || binding != originalBinding || matchProject != project || eventType != "task.created" || epoch != originalEpoch {
			t.Fatalf("original match differs: %s %s %s %s %d", subscription, binding, matchProject, eventType, epoch)
		}
		tuples, err := json.Marshal([][5]string{{originalSubscription, originalBinding, project, "task.created", fmt.Sprint(originalEpoch)}})
		if err != nil {
			t.Fatal(err)
		}
		proofDigest := sha256.Sum256(tuples)
		if !bytes.Equal(matchHash, proofDigest[:]) {
			t.Fatalf("original match digest differs: %x", matchHash)
		}
		previous = queue
	}
}
