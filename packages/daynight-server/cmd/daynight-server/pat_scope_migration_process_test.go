//go:build startupshutdown

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCredentialScopeActivationProcessStartup(t *testing.T) {
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
DROP INDEX webhook_endpoints_live_client_key_idx;
ALTER TABLE webhook_endpoints DROP COLUMN client_key;
ALTER TABLE task_sessions DROP COLUMN history_content_policy;
DELETE FROM schema_migrations WHERE version IN (108,109,110,111,112,113,114)`); err != nil {
		t.Fatal(err)
	}
	var latest int64
	if err := pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&latest); err != nil || latest != 107 {
		t.Fatalf("historical ledger: version=%d err=%v", latest, err)
	}
	user, team, tokenID, deviceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	grantID, accessID, authorizationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := secret.Random("dnpat_")
	deviceCode := secret.Random("")
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,'migration-process-user','Migration User',now(),now())`, []any{user}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, []any{team, user}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'historical',now()-interval '1 hour',now()+interval '1 hour')`, []any{tokenID, user, secret.Hash(token)}},
		{`INSERT INTO device_authorizations(id,device_code_hash,user_code,status,user_id,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES($1,$2,'BCDFGHJKLM','approved',$3,now()-interval '1 minute',now()+interval '1 hour',now(),5)`, []any{deviceID, secret.Hash(deviceCode), user}},
		{`INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',now()-interval '1 hour',now()+interval '1 hour')`, []any{grantID, user}},
		{`INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '30 minutes')`, []any{accessID, grantID, user, secret.Hash("historical-access")}},
		{`INSERT INTO oauth_authorizations(id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES($1,$2,'{}','client','https://client.test/callback','https://example.test/mcp','daynight:mcp','challenge','',false,'pending',now(),now()+interval '1 hour',now()+interval '1 day')`, []any{authorizationID, secret.Hash("binding")}},
	} {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	// Occupying the HTTP address fails startup after the migration ledger commits.
	// Recovery must use the upgraded schema without repeating or expanding policy.
	listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	failed := startMigrationProcess(t, values)
	select {
	case err := <-failed.finished:
		failed.stopped = true
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("occupied listener startup result: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("post-migration startup failure did not terminate")
	}
	var committed bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=111) AND EXISTS(SELECT FROM personal_access_tokens WHERE id=$1 AND cardinality(business_scopes)=67 AND scope_version=1)`, tokenID).Scan(&committed); err != nil || !committed {
		t.Fatalf("activation did not commit before listener failure: %v %v; %s", committed, err, failed.logs.String())
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	upgraded := startPersistenceProcess(t, values)
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT (SELECT count(*)=3 FROM schema_migrations WHERE version IN (108,109,111)) AND
EXISTS(SELECT FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND name='historical' AND expires_at>clock_timestamp() AND cardinality(business_scopes)=67 AND scope_version=1) AND
EXISTS(SELECT FROM device_authorizations WHERE id=$4 AND user_id=$2 AND status='approved' AND approved_business_scopes=(SELECT business_scopes FROM personal_access_tokens WHERE id=$1)) AND
EXISTS(SELECT FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id WHERE g.id=$5 AND a.id=$6 AND g.user_id=$2 AND cardinality(g.business_scopes)=37 AND g.scope_version=1) AND
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
	form := url.Values{"client_id": {"daynight-cli"}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {deviceCode}, "device_name": {"Historical device"}}
	for attempt, want := range []int{http.StatusOK, http.StatusBadRequest} {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, values["DAYNIGHT_PUBLIC_ORIGIN"]+"/api/v1/auth/device/token", strings.NewReader(form.Encode()))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
		}
		err = json.NewDecoder(response.Body).Decode(&result)
		response.Body.Close()
		if err != nil || response.StatusCode != want || attempt == 1 && result.Error != "invalid_grant" {
			t.Fatalf("historical device redemption attempt %d: status=%d error=%q decode=%v", attempt, response.StatusCode, result.Error, err)
		}
		if attempt == 0 {
			if result.AccessToken == "" {
				t.Fatal("redemption returned no token")
			}
			var inherited bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM personal_access_tokens WHERE token_hash=$1 AND business_scopes=(SELECT approved_business_scopes FROM device_authorizations WHERE id=$2) AND scope_version=1) AND (SELECT status='consumed' FROM device_authorizations WHERE id=$2)`, secret.Hash(result.AccessToken), deviceID).Scan(&inherited); err != nil || !inherited {
				t.Fatalf("historical approved scopes did not reach redeemed PAT: %v %v", inherited, err)
			}
		}
	}
	if err := upgraded.stop(); err != nil {
		t.Fatalf("stop upgraded process: %v", err)
	}
}
