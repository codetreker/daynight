package postgres

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

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
			mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'retained',now())`, queryID(1), queryID(2), deviceStoreHash("retained"))
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
