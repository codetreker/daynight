package postgres

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The immediately preceding deployed schema contains real rows before Open
// upgrades it; both Open calls must preserve those rows and the old ledger.
func TestWebhookUpgradePopulated47AndReopen(t *testing.T) {
	ctx := context.Background()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if len(schemaMigrations) != 49 || schemaMigrations[46].version != 47 || schemaMigrations[47].version != 48 || schemaMigrations[48].version != 49 {
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
		 configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,
		 destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'Name',true,1,1,'http',1,1,'https://example.test',1,'primary',
		 decode(repeat('00',12),'hex'),decode(repeat('00',32),'hex'),$3,now(),now())`, endpoint, owner, key)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_signing_keys
		(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at)
		VALUES($1,$2,'current',1,'primary',decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`, key, endpoint)
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
		{"partial endpoint envelope", `UPDATE webhook_endpoints SET destination_nonce=NULL`},
		{"zero config version", `UPDATE webhook_endpoints SET config_version=0`},
		{"invalid owner", `UPDATE webhook_endpoints SET owner_kind='user'`},
		{"invalid key ciphertext", `UPDATE webhook_signing_keys SET ciphertext=decode('00','hex')`},
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
		destination_envelope_version=NULL,destination_master_key_id=NULL,destination_nonce=NULL,
		destination_ciphertext=NULL,active_key_id=NULL WHERE id=$1`, endpoint); err != nil {
		t.Fatalf("valid tombstone: %v", err)
	}
}
