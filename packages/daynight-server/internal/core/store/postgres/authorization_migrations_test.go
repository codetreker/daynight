package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCredentialDescriptionMigrationPreservesRows(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 105 })
	if index < 1 {
		t.Fatal("migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('00',32),'hex'),'old',now()); INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','client','{}','resource','scope',now(),now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	indexQuery := `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('personal_access_tokens','oauth_grants')`
	var before, after string
	if err := pool.QueryRow(ctx, indexQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	broken := append([]migration(nil), schemaMigrations...)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := migrate(ctx, pool, broken); err == nil {
		t.Fatal("faulted migration succeeded")
	}
	var absent bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('personal_access_tokens','oauth_grants') AND column_name='description') AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=105)`).Scan(&absent); err != nil || !absent {
		t.Fatalf("migration failure was not rolled back: %v %v", absent, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*)=1 AND bool_and(description IS NULL AND name='old' AND encode(token_hash,'hex')=repeat('00',32)) FROM personal_access_tokens) AND (SELECT count(*)=1 AND bool_and(description IS NULL AND client_id='client' AND resource='resource' AND scope='scope') FROM oauth_grants)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("migration lost rows or null defaults: %v %v", ok, err)
	}
	if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
		t.Fatalf("indexes changed: %v", err)
	}
}

func TestCredentialScopeActivationMigration(t *testing.T) {
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 111 })
	if index < 1 {
		t.Fatal("credential scope activation migration missing")
	}
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,last_used_at,description)
SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000099',decode(repeat(lpad(n::text,2,'0'),32),'hex'),'legacy-'||n,now()-interval '2 hours',now()+(n-2)*interval '1 hour',now()-interval '1 hour','retained' FROM generate_series(1,3) n;
INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version)
VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000099',decode(repeat('04',32),'hex'),'already scoped',now(),ARRAY['task:read'],8);
INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at)
SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000099','client','{}','https://example.test/mcp',CASE WHEN n=4 THEN 'daynight:api' ELSE 'daynight:mcp' END,now()-interval '2 hours',now()+(n-2)*interval '1 hour',CASE WHEN n=3 THEN now()-interval '1 minute' END FROM generate_series(1,4) n;
INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at)
VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000099',decode(repeat('11',32),'hex'),now()-interval '2 hours',now()-interval '1 hour');
INSERT INTO oauth_refresh_tokens(token_hash,grant_id,client_id,created_at,expires_at,consumed_at)
VALUES (decode(repeat('12',32),'hex'),'00000000-0000-0000-0000-000000000001','client',now()-interval '2 hours',now()+interval '1 hour',now()-interval '1 hour');
INSERT INTO device_authorizations(id,device_code_hash,user_code,status,user_id,created_at,expires_at,next_poll_at,poll_interval_seconds)
SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,decode(repeat(lpad(n::text,2,'0'),32),'hex'),repeat(substr('BCDF',n,1),10),CASE n WHEN 1 THEN 'approved' WHEN 2 THEN 'pending' WHEN 3 THEN 'consumed' ELSE 'denied' END,CASE WHEN n<>2 THEN '00000000-0000-0000-0000-000000000099'::uuid END,now(),now()+interval '1 hour',now(),5 FROM generate_series(1,4) n;
INSERT INTO oauth_authorizations(id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,user_id,code_hash,created_at,expires_at,code_expires_at,retain_until)
SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,decode(repeat(lpad(n::text,2,'0'),32),'hex'),'{}','client','https://client.test','https://example.test/mcp',CASE WHEN n=4 THEN 'daynight:api' ELSE 'daynight:mcp' END,'challenge','state',true,CASE n WHEN 2 THEN 'pending' WHEN 3 THEN 'consumed' ELSE 'approved' END,'00000000-0000-0000-0000-000000000099',decode(repeat(lpad(n::text,2,'0'),32),'hex'),now(),now()+interval '1 hour',now()+interval '30 seconds',now()+interval '1 day' FROM generate_series(1,4) n;
CREATE TABLE activation_before AS
SELECT 'pat' AS kind,id,to_jsonb(p)-'business_scopes'-'scope_version' AS value FROM personal_access_tokens p
UNION ALL SELECT 'grant',id,to_jsonb(g)-'business_scopes'-'scope_version' FROM oauth_grants g
UNION ALL SELECT 'device',id,to_jsonb(d)-'approved_business_scopes' FROM device_authorizations d
UNION ALL SELECT 'authorization',id,to_jsonb(a)-'approved_business_scopes' FROM oauth_authorizations a
UNION ALL SELECT 'access',id,to_jsonb(a) FROM oauth_access_tokens a;
CREATE TABLE activation_refresh_before AS SELECT * FROM oauth_refresh_tokens;`)
	if err != nil {
		t.Fatal(err)
	}
	broken := slices.Clone(schemaMigrations)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := initializeSchema(ctx, pool, broken, currentSchemaSnapshot); err == nil {
		t.Fatal("faulted activation succeeded")
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM schema_migrations WHERE version=111) AND (SELECT count(*)=3 FROM personal_access_tokens WHERE business_scopes IS NULL AND scope_version IS NULL) AND NOT EXISTS(SELECT FROM oauth_grants WHERE business_scopes IS NOT NULL)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("failed activation did not roll back: %v %v", ok, err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err == nil {
		t.Fatal("pre-activation migration history accepted the committed activation ledger")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000099',decode(repeat('05',32),'hex'),'missing policy',now())`); err == nil {
		t.Fatal("activated schema accepted a PAT without an explicit policy")
	}
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		var ids []scopepolicy.ScopeID
		query := `SELECT business_scopes FROM personal_access_tokens WHERE name='legacy-1'`
		if kind == scopepolicy.MCP {
			query = `SELECT business_scopes FROM oauth_grants WHERE id='00000000-0000-0000-0000-000000000001'`
		}
		if err := pool.QueryRow(ctx, query).Scan(&ids); err != nil {
			t.Fatal(err)
		}
		// These fingerprints belong to the activation release, independent of later catalog additions.
		wantCount, wantHash := 67, "739183f68104c55b81ab57d3fa07840b0d8b6789c02746ab1cbee8de0470306b"
		if kind == scopepolicy.MCP {
			wantCount, wantHash = 37, "7298a749d473e44b49ecbb8b935daef93585bad33bec5bcfa4f0ada058035e4c"
		}
		values := make([]string, len(ids))
		for i, id := range ids {
			values[i] = string(id)
		}
		if len(ids) != wantCount || fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Join(values, ",")))) != wantHash {
			t.Fatalf("activation %s set differs from frozen release set: %v", kind, ids)
		}
		if kind == scopepolicy.MCP && !slices.Contains(ids, scopepolicy.ScopeID("worker:complete")) || !slices.Contains(ids, scopepolicy.ScopeID("team:write")) {
			t.Fatalf("migration applied new-approval defaults to %s: %v", kind, ids)
		}
	}
	const preserved = `WITH current_values AS (
SELECT 'pat' AS kind,id,to_jsonb(p)-'business_scopes'-'scope_version' AS value FROM personal_access_tokens p
UNION ALL SELECT 'grant',id,to_jsonb(g)-'business_scopes'-'scope_version' FROM oauth_grants g
UNION ALL SELECT 'device',id,to_jsonb(d)-'approved_business_scopes' FROM device_authorizations d
UNION ALL SELECT 'authorization',id,to_jsonb(a)-'approved_business_scopes' FROM oauth_authorizations a
UNION ALL SELECT 'access',id,to_jsonb(a) FROM oauth_access_tokens a)
SELECT NOT EXISTS((SELECT * FROM activation_before EXCEPT SELECT * FROM current_values) UNION ALL (SELECT * FROM current_values EXCEPT SELECT * FROM activation_before))
AND NOT EXISTS((SELECT * FROM activation_refresh_before EXCEPT SELECT * FROM oauth_refresh_tokens) UNION ALL (SELECT * FROM oauth_refresh_tokens EXCEPT SELECT * FROM activation_refresh_before))
AND (SELECT bool_and(scope_version=1) FROM personal_access_tokens WHERE name LIKE 'legacy-%')
AND (SELECT scope_version=8 AND business_scopes=ARRAY['task:read'] FROM personal_access_tokens WHERE name='already scoped')
AND (SELECT count(*)=3 AND bool_and(scope_version=1 AND business_scopes IS NOT NULL) FROM oauth_grants WHERE scope='daynight:mcp')
AND (SELECT business_scopes IS NULL AND scope_version IS NULL FROM oauth_grants WHERE scope='daynight:api')
AND (SELECT approved_business_scopes=(SELECT business_scopes FROM personal_access_tokens WHERE name='legacy-1') FROM device_authorizations WHERE status='approved')
AND NOT EXISTS(SELECT FROM device_authorizations WHERE status<>'approved' AND approved_business_scopes IS NOT NULL)
AND (SELECT approved_business_scopes=(SELECT business_scopes FROM oauth_grants WHERE id='00000000-0000-0000-0000-000000000001') FROM oauth_authorizations WHERE status='approved' AND scope='daynight:mcp')
AND NOT EXISTS(SELECT FROM oauth_authorizations WHERE (status<>'approved' OR scope<>'daynight:mcp') AND approved_business_scopes IS NOT NULL)`
	if err := pool.QueryRow(ctx, preserved).Scan(&ok); err != nil || !ok {
		t.Fatalf("activation changed credential identity, lifetime, state or existing policy: %v %v", ok, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['task:read'],scope_version=2 WHERE name='legacy-1'; UPDATE oauth_grants SET business_scopes=ARRAY['task:read'],scope_version=2 WHERE id='00000000-0000-0000-0000-000000000001'`); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT (SELECT business_scopes=ARRAY['task:read'] AND scope_version=2 FROM personal_access_tokens WHERE name='legacy-1') AND (SELECT business_scopes=ARRAY['task:read'] AND scope_version=2 FROM oauth_grants WHERE id='00000000-0000-0000-0000-000000000001')`).Scan(&ok); err != nil || !ok {
		t.Fatalf("restart expanded an edited policy: %v %v", ok, err)
	}
}

func TestCredentialUsageMigration(t *testing.T) {
	for _, upgrade := range []bool{false, true} {
		name := "new database"
		if upgrade {
			name = "upgrade"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			pool := emptyPool(t)
			if upgrade {
				if len(schemaMigrations) < 66 || schemaMigrations[64].version != 65 || schemaMigrations[65].version != 66 {
					t.Fatal("credential migration is not the successor of version 65")
				}
				if err := migrate(ctx, pool, schemaMigrations[:65]); err != nil {
					t.Fatal(err)
				}
			} else if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
				t.Fatal(err)
			}
			s := &Store{Pool: pool}
			if upgrade {
				mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'retained',now())`, queryID(1), queryID(2), deviceStoreHash("retained"))
			} else {
				mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'retained',now(),ARRAY['task:read'],1)`, queryID(1), queryID(2), deviceStoreHash("retained"))
			}
			mustQueryExec(t, s, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at) VALUES($1,$2,'client','{}','resource','scope',now(),now()+interval '1 day',now())`, queryID(3), queryID(2))
			if upgrade {
				if err := migrate(ctx, pool, schemaMigrations); err != nil {
					t.Fatal(err)
				}
			}
			assertCredentialMigrationValues(t, pool)
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			assertCredentialMigrationValues(t, pool)
			var version int64
			var checksum string
			if err := pool.QueryRow(ctx, `SELECT version,checksum FROM schema_migrations WHERE version=66`).Scan(&version, &checksum); err != nil || version != 66 || checksum != schemaMigrations[65].checksum() {
				t.Fatalf("migration ledger: version=%d checksum=%q error=%v", version, checksum, err)
			}
		})
	}
}

func assertCredentialMigrationValues(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var patName, grantClient string
	var patNull, grantNull, retainedRevocation bool
	err := pool.QueryRow(t.Context(), `SELECT (SELECT name FROM personal_access_tokens WHERE id=$1), (SELECT last_used_at IS NULL FROM personal_access_tokens WHERE id=$1), (SELECT client_id FROM oauth_grants WHERE id=$2), (SELECT last_used_at IS NULL FROM oauth_grants WHERE id=$2), (SELECT revoked_at IS NOT NULL FROM oauth_grants WHERE id=$2)`, queryID(1), queryID(3)).Scan(&patName, &patNull, &grantClient, &grantNull, &retainedRevocation)
	if err != nil || patName != "retained" || grantClient != "client" || !patNull || !grantNull || !retainedRevocation {
		t.Fatalf("credential state: name=%q patNull=%v client=%q grantNull=%v revoked=%v error=%v", patName, patNull, grantClient, grantNull, retainedRevocation, err)
	}
}

func TestOAuthScopePreparationMigration(t *testing.T) {
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 109 })
	if index < 1 {
		t.Fatal("OAuth scope migration missing")
	}
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','client','{}','https://example.test/mcp','daynight:mcp',now()-interval '1 hour',now()+interval '1 hour');
INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES
('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),now()-interval '1 minute',now()+interval '30 minutes');
INSERT INTO oauth_authorizations(id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES
('00000000-0000-0000-0000-000000000004',decode(repeat('02',32),'hex'),'{}','client','https://client.test','https://example.test/mcp','daynight:mcp','challenge','',false,'pending',now(),now()+interval '1 hour',now()+interval '1 day')`)
	if err != nil {
		t.Fatal(err)
	}
	const indexQuery = `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('oauth_grants','oauth_access_tokens','oauth_refresh_tokens','oauth_authorizations')`
	var before, after string
	if err := pool.QueryRow(ctx, indexQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	broken := append([]migration(nil), schemaMigrations...)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := initializeSchema(ctx, pool, broken, currentSchemaSnapshot); err == nil {
		t.Fatal("faulted migration succeeded")
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='oauth_grants' AND column_name IN ('business_scopes','scope_version')) OR (table_name='oauth_authorizations' AND column_name='approved_business_scopes'))) AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=109)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("failed migration left schema or ledger changes: %v %v", ok, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id WHERE g.id='00000000-0000-0000-0000-000000000001' AND a.token_hash=decode(repeat('01',32),'hex') AND g.business_scopes IS NULL AND g.scope_version IS NULL) AND EXISTS(SELECT FROM oauth_authorizations WHERE status='pending' AND approved_business_scopes IS NULL) AND EXISTS(SELECT FROM schema_migrations WHERE version=109)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("historical OAuth facts changed: %v %v", ok, err)
	}
	if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
		t.Fatalf("OAuth indexes changed: %v", err)
	}
	empty := emptyPool(t)
	if err := migrate(ctx, empty, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	if err := empty.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=109) AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='oauth_grants' AND column_name IN ('business_scopes','scope_version')) OR (table_name='oauth_authorizations' AND column_name='approved_business_scopes')))`).Scan(&ok); err != nil || !ok {
		t.Fatalf("empty schema missing OAuth scope preparation: %v %v", ok, err)
	}
}

func TestPATScopePreparationMigration(t *testing.T) {
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 108 })
	if index < 1 {
		t.Fatal("PAT scope migration missing")
	}

	t.Run("historical startup and rollback", func(t *testing.T) {
		pool := emptyPool(t)
		if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
			t.Fatal(err)
		}
		_, err := pool.Exec(ctx, `
INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,last_used_at)
VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),'old',now()-interval '2 hours',now()+interval '1 hour',now()-interval '1 hour');
INSERT INTO device_authorizations(id,device_code_hash,user_code,status,user_id,created_at,expires_at,next_poll_at,poll_interval_seconds)
VALUES ('00000000-0000-0000-0000-000000000003',decode(repeat('02',32),'hex'),'BCDFGHJKLM','approved','00000000-0000-0000-0000-000000000002',now()-interval '1 minute',now()+interval '1 hour',now(),5),
       ('00000000-0000-0000-0000-000000000004',decode(repeat('03',32),'hex'),'NPQRSTVWXZ','pending',NULL,now()-interval '1 minute',now()+interval '1 hour',now(),5)`)
		if err != nil {
			t.Fatal(err)
		}
		const indexQuery = `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('personal_access_tokens','device_authorizations')`
		var before, after string
		if err := pool.QueryRow(ctx, indexQuery).Scan(&before); err != nil {
			t.Fatal(err)
		}
		broken := append([]migration(nil), schemaMigrations...)
		broken[index].sql += "\nSELECT 1 / 0;"
		if err := initializeSchema(ctx, pool, broken, currentSchemaSnapshot); err == nil {
			t.Fatal("faulted migration succeeded")
		}
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN ('business_scopes','scope_version','approved_business_scopes') AND table_name IN ('personal_access_tokens','device_authorizations')) AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=108)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("failed migration left schema or ledger changes: %v %v", ok, err)
		}
		if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*)=1 AND bool_and(business_scopes IS NULL AND scope_version IS NULL AND name='old' AND encode(token_hash,'hex')=repeat('01',32) AND expires_at IS NOT NULL AND last_used_at IS NOT NULL) FROM personal_access_tokens) AND (SELECT count(*)=2 AND bool_and(approved_business_scopes IS NULL) AND count(*) FILTER (WHERE status='approved' AND user_id='00000000-0000-0000-0000-000000000002')=1 AND count(*) FILTER (WHERE status='pending' AND user_id IS NULL)=1 FROM device_authorizations)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("historical facts changed: %v %v", ok, err)
		}
		if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
			t.Fatalf("indexes changed: %v", err)
		}
	})

	t.Run("empty startup and existing writers", func(t *testing.T) {
		pool := emptyPool(t)
		if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
			t.Fatal(err)
		}
		_, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),'new',now()); INSERT INTO device_authorizations(id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES ('00000000-0000-0000-0000-000000000003',decode(repeat('02',32),'hex'),'BCDFGHJKLM','pending',now(),now()+interval '1 hour',now(),5)`)
		if err != nil {
			t.Fatal(err)
		}
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT (SELECT business_scopes IS NULL AND scope_version IS NULL FROM personal_access_tokens) AND (SELECT approved_business_scopes IS NULL FROM device_authorizations) AND EXISTS(SELECT FROM schema_migrations WHERE version=108)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("preparation defaults or ledger incorrect: %v %v", ok, err)
		}
	})
}

func TestAPIOAuthMigrationPreservesFamiliesAndOnlyRelaxesFixedAPILifetime(t *testing.T) {
	ctx, pool := t.Context(), emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:66]); err != nil {
		t.Fatal(err)
	}
	created := time.Now().UTC().Truncate(time.Microsecond)
	expires := created.Add(30 * 24 * time.Hour)
	used := created.Add(time.Minute)
	grant, access, user := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := `{"client_id":"historical-client","client_name":"Historical tool"}`
	if _, err := pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,last_used_at) VALUES($1,$2,'historical-client',$3,'https://example.test/mcp','daynight:mcp',$4,$5,$6)`, grant, user, snapshot, created, expires, used); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, access, grant, user, deviceStoreHash("historical-access"), created, created.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var gotUser, gotClient, gotResource, gotScope, gotAccess string
	var gotSnapshot []byte
	var gotCreated, gotExpires, gotUsed time.Time
	if err := pool.QueryRow(ctx, `SELECT g.user_id::text,g.client_id,g.client_snapshot,g.resource,g.scope,g.created_at,g.expires_at,g.last_used_at,a.id::text FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id WHERE g.id=$1`, grant).Scan(&gotUser, &gotClient, &gotSnapshot, &gotResource, &gotScope, &gotCreated, &gotExpires, &gotUsed, &gotAccess); err != nil {
		t.Fatal(err)
	}
	var wantJSON, gotJSON any
	if err := json.Unmarshal([]byte(snapshot), &wantJSON); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(gotSnapshot, &gotJSON); err != nil {
		t.Fatal(err)
	}
	if gotUser != user || gotClient != "historical-client" || gotResource != "https://example.test/mcp" || gotScope != "daynight:mcp" || gotAccess != access || !gotCreated.Equal(created) || !gotExpires.Equal(expires) || !gotUsed.Equal(used) {
		t.Fatalf("migration changed historical family: %s %s %s %s %s %v %v %v", gotUser, gotClient, gotResource, gotScope, gotAccess, gotCreated, gotExpires, gotUsed)
	}
	wantBytes, _ := json.Marshal(wantJSON)
	gotBytes, _ := json.Marshal(gotJSON)
	if string(wantBytes) != string(gotBytes) {
		t.Fatalf("snapshot changed: %s", gotSnapshot)
	}
	for _, test := range []struct {
		name, client, scope string
		accepted            bool
	}{
		{"fixed API", "societas-bot", "daynight:api", true},
		{"foreign API client", "foreign-client", "daynight:api", false},
		{"MCP fixed client", "societas-bot", "daynight:mcp", false},
		{"historical MCP", "historical-client", "daynight:mcp", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,$3,'{}','resource',$4,$5,$6)`, uuid.NewString(), user, test.client, test.scope, created, expires.Add(time.Hour))
			if (err == nil) != test.accepted {
				t.Fatalf("lifetime accepted=%v error=%v", test.accepted, err)
			}
		})
	}
	var checksum string
	if err := pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version=67`).Scan(&checksum); err != nil || checksum != schemaMigrations[66].checksum() {
		t.Fatalf("migration ledger: %q %v", checksum, err)
	}
}

func TestLoginScopeMigrationProtectsLiveTransactions(t *testing.T) {
	for _, resolution := range []string{"consume", "expire"} {
		t.Run(resolution, func(t *testing.T) {
			ctx := context.Background()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:46]); err != nil {
				t.Fatal(err)
			}
			_, err := pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at)
 VALUES ('00000000-0000-4000-8000-000000000001',decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),'github','/',clock_timestamp()+interval '10 minutes'),
 ('00000000-0000-4000-8000-000000000002',decode(repeat('03',32),'hex'),decode(repeat('04',32),'hex'),'github','/',clock_timestamp()-interval '1 minute')`)
			if err != nil {
				t.Fatal(err)
			}
			err = migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != "P1047" {
				t.Fatalf("expected active login migration failure: %v", err)
			}
			_, err = Open(ctx, pool.Config().ConnString())
			if err == nil || !strings.Contains(err.Error(), "active login transactions to be consumed or expired") {
				t.Fatalf("startup did not explain migration failure: %v", err)
			}
			var rows, columns, versions int
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),
 (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='login_transactions' AND column_name='scope_hash'),
 (SELECT count(*) FROM schema_migrations WHERE version=47)`).Scan(&rows, &columns, &versions); err != nil || rows != 2 || columns != 0 || versions != 0 {
				t.Fatalf("failed migration changed data or schema: rows=%d columns=%d ledger=%d err=%v", rows, columns, versions, err)
			}
			if resolution == "consume" {
				_, err = pool.Exec(ctx, `DELETE FROM login_transactions WHERE id='00000000-0000-4000-8000-000000000001' AND state_hash=decode(repeat('01',32),'hex') AND browser_binding_hash=decode(repeat('02',32),'hex')`)
			} else {
				_, err = pool.Exec(ctx, `UPDATE login_transactions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='00000000-0000-4000-8000-000000000001'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions`).Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("expired transactions remain: %d %v", rows, err)
			}
			_, err = pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at) VALUES ('00000000-0000-4000-8000-000000000003',decode(repeat('05',32),'hex'),decode(repeat('06',32),'hex'),'github','/',clock_timestamp()+interval '1 minute')`)
			if err == nil {
				t.Fatal("scope hash accepted as NULL")
			}
		})
	}
}
func storeTokenExpiry(value time.Time) *time.Time { return &value }

func TestOptionalTokenExpiryMigrationPreservesHistoryAndSessionContract(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:18]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, session := identitySession(uuid.NewString(), "historical:"+uuid.NewString())
	session.CreatedAt = now.Add(-time.Hour)
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,$3,$3)`, user.ID, user.UniAuthID, now)
	mustQueryExec(t, s, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`, session.ID, user.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
	p := model.Principal{Kind: model.SessionCredential, UserID: user.ID, CredentialID: session.ID}
	finite := deviceStoreCredential(now)
	finite.ExpiresAt = storeTokenExpiry(now.Add(30 * 24 * time.Hour))
	finite.UserID = p.UserID
	if _, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, finite.ID, finite.UserID, finite.TokenHash, finite.Name, finite.CreatedAt, finite.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'last_used_at'-'description'-'business_scopes'-'scope_version')::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'last_used_at'-'description'-'business_scopes'-'scope_version')::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("optional expiry changed historical credential: %v", err)
	}
	var descriptionNull bool
	if err := pool.QueryRow(ctx, `SELECT description IS NULL FROM personal_access_tokens WHERE id=$1`, finite.ID).Scan(&descriptionNull); err != nil || !descriptionNull {
		t.Fatalf("historical token description is not null: %v", err)
	}
	var patRequired, sessionRequired bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid='personal_access_tokens'::regclass AND attname='expires_at'),(SELECT attnotnull FROM pg_attribute WHERE attrelid='sessions'::regclass AND attname='expires_at')`).Scan(&patRequired, &sessionRequired); err != nil || patRequired || !sessionRequired {
		t.Fatalf("expiry schema boundaries: PAT=%t session=%t %v", patRequired, sessionRequired, err)
	}
	never := deviceStoreCredential(now)
	never.UserID = p.UserID
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, never) }); err != nil {
		t.Fatal(err)
	}
	future := now.Add(365 * 24 * time.Hour)
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("nonexpiring token expired: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, finite.TokenHash, future); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("historical finite expiry lost: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.SessionCredential, session.TokenHash, future); err != nil {
		t.Fatalf("application clock expired a live browser session: %v", err)
	}
	mustQueryExec(t, s, `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, session.ID)
	if _, err := testAuthenticate(s, ctx, model.SessionCredential, session.TokenHash, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("session became nonexpiring: %v", err)
	}
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().CleanupCredentials(ctx, future) }); err != nil {
		t.Fatal(err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("cleanup deleted nonexpiring token: %v", err)
	}
}
