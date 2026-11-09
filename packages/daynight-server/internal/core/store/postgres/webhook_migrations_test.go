package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookCaptureMigrationAndConstraints(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if len(schemaMigrations) < 50 || schemaMigrations[48].version != 49 || schemaMigrations[49].version != 50 {
		t.Fatal("unexpected capture migration boundary")
	}
	before := schemaMigrations[:49]
	if err := migrate(ctx, pool, before); err != nil {
		t.Fatal(err)
	}
	var ledger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:50]); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version < 50`).Scan(&after); err != nil || after != ledger {
		t.Fatalf("old migration ledger changed: %v", err)
	}

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
func TestWebhookUpgradePopulated47AndReopen(t *testing.T) {
	ctx := context.Background()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if len(schemaMigrations) < 51 || schemaMigrations[46].version != 47 || schemaMigrations[47].version != 48 || schemaMigrations[48].version != 49 || schemaMigrations[49].version != 50 || schemaMigrations[50].version != 51 {
		pool.Close()
		t.Fatal("unexpected migration history")
	}
	if err := migrate(ctx, pool, schemaMigrations[:47]); err != nil {
		pool.Close()
		t.Fatal(err)
	}
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
		err = db.Pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=47), (SELECT count(*) FROM schema_migrations),t.title,t.description,t.version,u.name,tm.role FROM tasks t JOIN project_ownership po ON po.project_id=t.project_id JOIN team_members tm ON tm.team_id=po.team_id JOIN users u ON u.id=tm.user_id WHERE t.id=$1 AND u.id=$2`, task, user).Scan(&ledger, &count, &title, &description, &version, &name, &role)
		if err != nil || ledger != oldLedger || count != len(schemaMigrations) || title != "Existing task" || description != "Preserved text" || version != 9007199254740993 || name != "Existing user" || role != "admin" {
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

func TestWebhookRedeliveryMigrationPreservesReceiptsAndEnforcesResult(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:51]); err != nil {
		t.Fatal(err)
	}
	owner, operation, actor, endpoint, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,recorded_at,expires_at) VALUES('personal',$1,$2,$3,$4,'endpoint.create','2026-11-07T10:00:00Z',decode(repeat('aa',32),'hex'),1,decode(repeat('bb',32),'hex'),'applied',1,1,now(),now()+interval '30 days')`, owner, operation, actor, endpoint); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT row_to_json(o)::text FROM webhook_operations o WHERE operation_id=$1`, operation).Scan(&before); err != nil {
		t.Fatal(err)
	}
	var ledger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after, afterLedger string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(o)-'delivery_id'-'generation_after')::text FROM webhook_operations o WHERE operation_id=$1`, operation).Scan(&after); err != nil {
		t.Fatal(err)
	}
	var originalJSON string
	if err := pool.QueryRow(ctx, `SELECT $1::jsonb::text`, before).Scan(&originalJSON); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=51`).Scan(&afterLedger); err != nil || before == "" || after != originalJSON || afterLedger != ledger {
		t.Fatalf("migration changed existing receipt or ledger: %v", err)
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
