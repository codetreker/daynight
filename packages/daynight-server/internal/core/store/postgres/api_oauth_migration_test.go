package postgres

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

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
