package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookCaptureConstraints(t *testing.T) {
	ctx := context.Background()
	pool := isolatedStore(t).Pool
	event, project, task, endpoint, owner, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO webhook_events
		(id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,
		 occurred_at,recorded_at,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
		VALUES ($1,'task.created',1,1,'urn:daynight:project:' || $2::uuid::text,'tasks/' || $3::uuid::text,$2,$3,1,
		 now(),now(),1,convert_to('{}','UTF8'),sha256(convert_to('{}','UTF8')),2)`, event, project, task)
	if err != nil {
		t.Fatal(err)
	}
	insertDelivery := `INSERT INTO webhook_deliveries
		(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,
		 policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,
		 destination_configuration,request_method,request_media_type,
		 deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,
		 automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,
		 expires_at,next_attempt_at,last_activity_at,metadata_expires_at)
		VALUES ($1,$2,$3,'personal',$4,'task.created',$5,now(),1,decode(repeat('00',32),'hex'),
		 1,1,'http',1,1,1,'https://example.test',convert_to('{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.test/hook"}}','UTF8'),
		 'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('{}','UTF8'),2,sha256(convert_to('{}','UTF8')),
		 ARRAY(SELECT now() + i * interval '1 minute' FROM generate_series(0,9) i ORDER BY i),now()+interval '72 hours',now()+interval '168 hours',
		 0,true,0,0,0,1,'pending','automatic',now()+interval '72 hours',now(),now(),now()+interval '30 days') RETURNING queue_order`
	var first, second int64
	if err := pool.QueryRow(ctx, insertDelivery, delivery, event, endpoint, owner, project).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, insertDelivery, uuid.NewString(), event, uuid.NewString(), owner, project).Scan(&second); err != nil || first <= 0 || second <= first {
		t.Fatalf("queue tickets %d, %d: %v", first, second, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_delivery_matches(delivery_id,subscription_id,binding_id,project_id,event_type,authorization_epoch)
		VALUES($1,$2,$3,$4,'task.created',1)`, delivery, uuid.NewString(), uuid.NewString(), project)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, query string }{
		{"missing fact", `UPDATE webhook_events SET fact_bytes=NULL`},
		{"fact hash", `UPDATE webhook_events SET fact_bytes=convert_to('xx','UTF8')`},
		{"wrong event anchor", `UPDATE webhook_events SET step_id=1`},
		{"missing payload marker", `UPDATE webhook_deliveries SET body=NULL`},
		{"wrong payload hash", `UPDATE webhook_deliveries SET body=convert_to('xx','UTF8')`},
		{"partial target", `UPDATE webhook_deliveries SET destination_configuration=NULL`},
		{"empty target", `UPDATE webhook_deliveries SET destination_configuration=decode('','hex')`},
		{"oversized target", `UPDATE webhook_deliveries SET destination_configuration=convert_to(repeat('x',262145),'UTF8')`},
		{"partial lease", `UPDATE webhook_deliveries SET state='leased'`},
		{"invalid schedule", `UPDATE webhook_deliveries SET automatic_schedule_at[2]=automatic_schedule_at[1]`},
		{"empty proof", `UPDATE webhook_deliveries SET original_match_count=0`},
		{"invalid epoch", `UPDATE webhook_delivery_matches SET authorization_epoch=0`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.query); err == nil {
				t.Fatal("invalid state was accepted")
			}
		})
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=now()`); err != nil {
		t.Fatalf("valid fact removal: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=now(),payload_removed_reason='expired'`); err != nil {
		t.Fatalf("valid payload removal: %v", err)
	}
}

// The immediately preceding deployed schema contains real rows before Open
// upgrades it; both Open calls must preserve those rows and the old ledger.
func TestWebhookPolicyAndPopulatedBaselineReopen(t *testing.T) {
	ctx := context.Background()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapBaseline(t, pool)
	user, team, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Existing user',now(),now())`, []any{user, "identity-" + user}},
		{`INSERT INTO teams(id,name) VALUES($1,'Existing team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Existing project','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title,description,version) VALUES($1,$2,'Existing task','Preserved text',9007199254740993)`, []any{task, project}},
	} {
		if _, err := pool.Exec(ctx, step.query, step.args...); err != nil {
			pool.Close()
			t.Fatal(err)
		}
	}
	var oldLedger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&oldLedger); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	pool.Close()
	for attempt := 0; attempt < 2; attempt++ {
		db, err := Open(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		var ledger, title, description, name, role string
		var version int64
		var count int
		err = db.Pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=99), (SELECT count(*) FROM schema_migrations),t.title,t.description,t.version,u.name,tm.role FROM tasks t JOIN project_ownership po ON po.project_id=t.project_id JOIN team_members tm ON tm.team_id=po.team_id JOIN users u ON u.id=tm.user_id WHERE t.id=$1 AND u.id=$2`, task, user).Scan(&ledger, &count, &title, &description, &version, &name, &role)
		if err != nil || ledger != oldLedger || count != 97+len(schemaMigrations) || title != "Existing task" || description != "Preserved text" || version != 9007199254740993 || name != "Existing user" || role != "admin" {
			db.Close()
			t.Fatalf("open %d changed data or ledger: count=%d title=%q version=%d err=%v", attempt, count, title, version, err)
		}
		var policyMatches bool
		err = db.Pool.QueryRow(ctx, `SELECT max_automatic_attempts=10 AND automatic_window_seconds=259200
			AND automatic_offsets_seconds=ARRAY[0,60,300,1800,7200,21600,43200,86400,172800,255600]
			AND max_manual_operations=3 AND payload_retention_seconds=604800
			AND metadata_retention_seconds=2592000 AND operation_retention_seconds=2592000
			AND operation_max_age_seconds=300 AND operation_future_skew_seconds=60
			AND http_timeout_seconds=15 AND lease_seconds=45 AND minimum_failure_wait_seconds=5
			AND jitter_basis_points=1000 AND jitter_max_seconds=1800
			AND key_overlap_default_seconds=86400 AND key_overlap_max_seconds=604800
			FROM webhook_policies WHERE version=1`).Scan(&policyMatches)
		db.Close()
		if err != nil || !policyMatches {
			t.Fatalf("open %d missing or incorrect webhook policy: %v", attempt, err)
		}
	}
}

func TestWebhookSchemaConstraints(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	owner, endpoint, key := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,
		 configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'Name',true,1,1,'http',1,1,'https://example.test',convert_to('{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.test/hook"}}','UTF8'),$3,now(),now())`, endpoint, owner, key)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_signing_keys
		(id,endpoint_id,slot,secret,created_at)
		VALUES($1,$2,'current',decode(repeat('00',32),'hex'),now())`, key, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_operations
		(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,
		 fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,recorded_at,expires_at)
		VALUES('personal',$1,$2,$1,$3,'endpoint.create','2026-01-01T00:00:00Z',decode(repeat('00',32),'hex'),
		 1,decode(repeat('00',32),'hex'),'applied',1,1,now(),now()+interval '30 days')`, owner, uuid.NewString(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, query string }{
		{"missing endpoint configuration", `UPDATE webhook_endpoints SET destination_configuration=NULL`},
		{"empty endpoint configuration", `UPDATE webhook_endpoints SET destination_configuration=decode('','hex')`},
		{"oversized endpoint configuration", `UPDATE webhook_endpoints SET destination_configuration=convert_to(repeat('x',262145),'UTF8')`},
		{"zero config version", `UPDATE webhook_endpoints SET config_version=0`},
		{"invalid owner", `UPDATE webhook_endpoints SET owner_kind='user'`},
		{"invalid signing secret", `UPDATE webhook_signing_keys SET secret=decode('00','hex')`},
		{"incomplete overlap", `UPDATE webhook_signing_keys SET slot='overlap',overlap_until=now()`},
		{"policy update", `UPDATE webhook_policies SET http_timeout_seconds=16 WHERE version=1`},
		{"wrong request hash length", `UPDATE webhook_operations SET request_sha256=decode('00','hex')`},
		{"incomplete rotation result", `UPDATE webhook_operations SET kind='signing-secret.rotate'`},
		{"partial tombstone", `UPDATE webhook_endpoints SET deleted_at=now(),enabled=false`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.query); err == nil {
				t.Fatal("invalid state was accepted")
			}
		})
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET deleted_at=now(),enabled=false,name=NULL,
		destination_kind=NULL,adapter_version=NULL,configuration_schema_version=NULL,destination_origin=NULL,
		destination_configuration=NULL,active_key_id=NULL WHERE id=$1`, endpoint); err != nil {
		t.Fatalf("valid tombstone: %v", err)
	}
}

func TestWebhookRedeliveryResultConstraints(t *testing.T) {
	ctx := context.Background()
	pool := isolatedStore(t).Pool
	owner, operation, actor, endpoint, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,recorded_at,expires_at) VALUES('personal',$1,$2,$3,$4,'endpoint.create','2026-11-07T10:00:00Z',decode(repeat('aa',32),'hex'),1,decode(repeat('bb',32),'hex'),'applied',1,1,now(),now()+interval '30 days')`, owner, operation, actor, endpoint); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`UPDATE webhook_operations SET kind='delivery.redeliver' WHERE $1::uuid IS NOT NULL`,
		`UPDATE webhook_operations SET delivery_id=$1,generation_after=1`,
		`UPDATE webhook_operations SET kind='delivery.redeliver',delivery_id=$1,generation_after=0`,
	} {
		_, err := pool.Exec(ctx, query, delivery)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("invalid redelivery result not rejected by check: %s: %v", query, err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_operations SET kind='delivery.redeliver',delivery_id=$1,generation_after=2`, delivery); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookEventWithoutAnActorHasUnknownProvenance(t *testing.T) {
	ctx := t.Context()
	db := isolatedStore(t)
	pool := db.Pool
	project := queryProject(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Legacy')`, queryID(10), project.ID)
	mustQueryExec(t, db, `INSERT INTO webhook_events
 (id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,
 occurred_at,recorded_at,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
 VALUES($1,'task.paused',1,1,'urn:daynight:project:' || $2::uuid::text,'tasks/' || $3::uuid::text,$2,$3,17,
 '2026-01-01T10:00:00Z','2026-01-01T10:00:01Z',1,convert_to('{}','UTF8'),sha256(convert_to('{}','UTF8')),2)`, queryID(90), project.ID, queryID(10))
	var nullable int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name='webhook_events'
 AND column_name IN ('actor_kind','actor_user_id','actor_bot_id') AND is_nullable='YES' AND column_default IS NULL`).Scan(&nullable); err != nil || nullable != 3 {
		t.Fatalf("actor columns: nullable=%d err=%v", nullable, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	got, err := webhook.New(tx).CapturedEventProvenance(ctx, queryID(90))
	if err != nil || got.Actor != (wm.Actor{}) || got.FactRemovedAt != nil || len(got.FactSHA256) != 32 {
		t.Fatalf("legacy provenance = %+v err=%v", got, err)
	}
}

// The fixture is a real pre-retirement schema, with multiple affected
// subscriptions on one endpoint and a separate unaffected endpoint.
func stepWebhookMigrationFixture(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 118)
	db := &Store{Pool: pool}
	mustQueryExec(t, db, `INSERT INTO webhook_endpoints
 (id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,client_key,created_at,updated_at)
 VALUES ($1,'personal',$3,'mixed',true,7,3,'http',1,1,'https://example.test',convert_to('config','UTF8'),$4,'client-mixed','2026-01-01','2026-01-01'),
        ($2,'personal',$3,'unaffected',true,9,4,'http',1,1,'https://example.test',convert_to('config','UTF8'),$5,'client-other','2026-01-01','2026-01-01')`, queryID(1), queryID(2), queryID(3), queryID(4), queryID(5))
	mustQueryExec(t, db, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,secret,created_at)
 VALUES ($1,$2,'current',decode(repeat('01',32),'hex'),'2026-01-01'),($3,$4,'current',decode(repeat('02',32),'hex'),'2026-01-01')`, queryID(4), queryID(1), queryID(5), queryID(2))
	mustQueryExec(t, db, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at)
 VALUES ($1,$5,$7,'personal',$8,'active',11,'2026-01-01','2026-01-01'),
        ($2,$5,$7,'personal',$8,'confirmation_required',12,'2026-01-01','2026-01-01'),
        ($3,$5,$7,'personal',$8,'active',13,'2026-01-01','2026-01-01'),
        ($4,$6,$7,'personal',$8,'active',14,'2026-01-01','2026-01-01')`, queryID(10), queryID(11), queryID(12), queryID(13), queryID(1), queryID(2), queryID(6), queryID(3))
	mustQueryExec(t, db, `INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at,deleted_at)
 VALUES ($1,$7,'task.step_updated','2026-01-01',NULL),
        ($2,$7,'task.created','2026-01-01',NULL),
        ($3,$8,'task.step_updated','2026-01-01',NULL),
        ($4,$9,'task.step_updated','2026-01-01',NULL),
        ($5,$10,'task.created','2026-01-01',NULL),
        ($6,$10,'task.step_updated','2026-01-01','2026-01-02')`, queryID(20), queryID(21), queryID(22), queryID(23), queryID(24), queryID(25), queryID(10), queryID(11), queryID(12), queryID(13))
	return pool
}

func stepWebhookRows(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var rows string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_endpoints e),
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM webhook_subscriptions s),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM webhook_bindings b),
 (SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM webhook_signing_keys k))::text`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestRetireStepWebhookBindingsMigration(t *testing.T) {
	ctx := t.Context()
	pool := stepWebhookMigrationFixture(t)
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT to_jsonb(e)-'config_version'-'updated_at' FROM webhook_endpoints e WHERE id=$1),
 (SELECT to_jsonb(s) FROM webhook_subscriptions s WHERE id=$2),
 (SELECT to_jsonb(b) FROM webhook_bindings b WHERE id=$3),
 (SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM webhook_signing_keys k))::text`, queryID(1), queryID(10), queryID(21)).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT
 (SELECT count(*)=0 FROM webhook_bindings WHERE event_type='task.step_updated' AND deleted_at IS NULL)
 AND (SELECT count(*)=3 FROM webhook_bindings WHERE id IN ($1,$2,$3) AND deleted_at IS NOT NULL)
 AND (SELECT deleted_at='2026-01-02'::timestamptz FROM webhook_bindings WHERE id=$4)
 AND (SELECT deleted_at IS NULL AND authorization_epoch=11 FROM webhook_subscriptions WHERE id=$5)
 AND (SELECT count(*)=2 FROM webhook_subscriptions WHERE id IN ($6,$7) AND deleted_at IS NOT NULL AND updated_at>'2026-01-01')
 AND (SELECT deleted_at IS NULL AND authorization_epoch=14 AND updated_at='2026-01-01'::timestamptz FROM webhook_subscriptions WHERE id=$8)
 AND (SELECT config_version=8 AND destination_revision=3 AND client_key='client-mixed' AND updated_at>'2026-01-01' FROM webhook_endpoints WHERE id=$9)
 AND (SELECT config_version=9 AND updated_at='2026-01-01'::timestamptz FROM webhook_endpoints WHERE id=$10)
 AND (SELECT count(*)=1 FROM schema_migrations WHERE version=119)`, queryID(20), queryID(22), queryID(23), queryID(25), queryID(10), queryID(11), queryID(12), queryID(13), queryID(1), queryID(2)).Scan(&ok); err != nil || !ok {
		t.Fatalf("retired bindings, subscriptions, endpoints or ledger: ok=%v err=%v", ok, err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT to_jsonb(e)-'config_version'-'updated_at' FROM webhook_endpoints e WHERE id=$1),
 (SELECT to_jsonb(s) FROM webhook_subscriptions s WHERE id=$2),
 (SELECT to_jsonb(b) FROM webhook_bindings b WHERE id=$3),
 (SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM webhook_signing_keys k))::text`, queryID(1), queryID(10), queryID(21)).Scan(&after); err != nil || after != before {
		t.Fatalf("mixed subscription, binding, endpoint or keys changed: before=%s after=%s err=%v", before, after, err)
	}
	rows := stepWebhookRows(t, pool)
	if err := migrate(ctx, pool, schemaMigrations); err != nil || stepWebhookRows(t, pool) != rows {
		t.Fatalf("repeated migration changed rows: %v", err)
	}
}

func TestRetireStepWebhookBindingsMigrationRollback(t *testing.T) {
	ctx := t.Context()
	pool := stepWebhookMigrationFixture(t)
	before := stepWebhookRows(t, pool)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_step_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected endpoint failure'; END $$;
 CREATE TRIGGER reject_step_retirement BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION reject_step_retirement()`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err == nil {
		t.Fatal("migration succeeded despite injected failure")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=119`).Scan(&count); err != nil || count != 0 || stepWebhookRows(t, pool) != before {
		t.Fatalf("failed migration left partial data or ledger: count=%d err=%v", count, err)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER reject_step_retirement ON webhook_endpoints; DROP FUNCTION reject_step_retirement()`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("recovery after failure: %v", err)
	}
}

func TestWebhookSourceCaptureAfterBaselineUpgrade(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	bootstrapBaseline(t, pool)
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
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	endpoint, key, originalSubscription, originalBinding := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	const originalEpoch int64 = 1
	destination := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`)
	secret := bytes.Repeat([]byte{9}, 32)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://receiver.example',$3,$4,now(),now())`, []any{endpoint, user, destination, key}},
		{`INSERT INTO webhook_signing_keys(id,endpoint_id,slot,secret,created_at) VALUES($1,$2,'current',$3,now())`, []any{key, endpoint, secret}},
		{`INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, []any{originalSubscription, endpoint, project, user}},
		{`INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at) VALUES($1,$2,'task.created',now())`, []any{originalBinding, originalSubscription}},
	} {
		if _, err = pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() string {
		var value string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=99),
 'task',(SELECT to_jsonb(t)-'ancestor_deleted_at' FROM tasks t WHERE id=$1),
 'endpoints',(SELECT jsonb_agg(to_jsonb(e)-'client_key' ORDER BY id) FROM webhook_endpoints e),
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
	if err = migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	upgraded := &Store{Pool: pool}
	if after := snapshot(); after != before {
		t.Fatalf("baseline data or old ledger changed: before=%s after=%s", before, after)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 97+len(schemaMigrations) {
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
	tasks := taskservice.NewTasks(upgraded, &webhookservice.Capturer{})
	status := model.TaskTodo
	var previous int64
	for n := 0; n < 2; n++ {
		created, err := tasks.Create(ctx, principal, project, taskcore.CreateTask{Title: fmt.Sprintf("after upgrade %d", n), Status: &status})
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
