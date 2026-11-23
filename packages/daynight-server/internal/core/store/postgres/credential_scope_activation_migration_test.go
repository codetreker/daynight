package postgres

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

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
