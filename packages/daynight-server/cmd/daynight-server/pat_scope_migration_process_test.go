//go:build startupshutdown

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPATScopePreparationProcessStartup(t *testing.T) {
	values := processAPIEnvironment(t)
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	// The first process initializes an empty schema through the snapshot path.
	initial := startPersistenceProcess(t, values)
	if err := initial.stop(); err != nil {
		t.Fatalf("stop empty-schema process: %v", err)
	}
	// These additive migrations can be removed to reconstruct the 107 schema.
	if _, err := pool.Exec(ctx, `ALTER TABLE personal_access_tokens DROP COLUMN business_scopes, DROP COLUMN scope_version;
ALTER TABLE device_authorizations DROP COLUMN approved_business_scopes;
ALTER TABLE oauth_grants DROP COLUMN business_scopes, DROP COLUMN scope_version;
ALTER TABLE oauth_authorizations DROP COLUMN approved_business_scopes;
DROP TABLE worker_lifecycle_observations, worker_lifecycle_operations, worker_lifecycle;
ALTER TABLE session_operations DROP COLUMN worker_id, DROP COLUMN worker_intent_version;
DELETE FROM schema_migrations WHERE version IN (108,109,110)`); err != nil {
		t.Fatal(err)
	}
	var latest int64
	if err := pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&latest); err != nil || latest != 107 {
		t.Fatalf("historical ledger: version=%d err=%v", latest, err)
	}
	user, team, tokenID, deviceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	grantID, accessID, authorizationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := secret.Random("dnpat_")
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,'migration-process-user','Migration User',now(),now())`, []any{user}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, []any{team, user}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'historical',now()-interval '1 hour',now()+interval '1 hour')`, []any{tokenID, user, secret.Hash(token)}},
		{`INSERT INTO device_authorizations(id,device_code_hash,user_code,status,user_id,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES($1,$2,'BCDFGHJKLM','approved',$3,now()-interval '1 minute',now()+interval '1 hour',now(),5)`, []any{deviceID, secret.Hash("device"), user}},
		{`INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',now()-interval '1 hour',now()+interval '1 hour')`, []any{grantID, user}},
		{`INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '30 minutes')`, []any{accessID, grantID, user, secret.Hash("historical-access")}},
		{`INSERT INTO oauth_authorizations(id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES($1,$2,'{}','client','https://client.test/callback','https://example.test/mcp','daynight:mcp','challenge','',false,'pending',now(),now()+interval '1 hour',now()+interval '1 day')`, []any{authorizationID, secret.Hash("binding")}},
	} {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	upgraded := startPersistenceProcess(t, values)
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT (SELECT count(*)=2 FROM schema_migrations WHERE version IN (108,109)) AND
EXISTS(SELECT FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND name='historical' AND expires_at>clock_timestamp() AND business_scopes IS NULL AND scope_version IS NULL) AND
EXISTS(SELECT FROM device_authorizations WHERE id=$4 AND user_id=$2 AND status='approved' AND approved_business_scopes IS NULL) AND
EXISTS(SELECT FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id WHERE g.id=$5 AND a.id=$6 AND g.user_id=$2 AND g.business_scopes IS NULL AND g.scope_version IS NULL) AND
EXISTS(SELECT FROM oauth_authorizations WHERE id=$7 AND status='pending' AND approved_business_scopes IS NULL)`, tokenID, user, secret.Hash(token), deviceID, grantID, accessID, authorizationID).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("historical credential or migration ledger was not preserved: %v %v", preserved, err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, values["DAYNIGHT_PUBLIC_ORIGIN"]+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var got api.User
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil || response.StatusCode != http.StatusOK || got.ID != user {
		t.Fatalf("historical token returned status %d, user %q, err %v", response.StatusCode, got.ID, err)
	}
	if err := upgraded.stop(); err != nil {
		t.Fatalf("stop upgraded process: %v", err)
	}
}
