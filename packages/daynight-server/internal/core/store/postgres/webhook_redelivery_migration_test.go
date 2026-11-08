package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

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
