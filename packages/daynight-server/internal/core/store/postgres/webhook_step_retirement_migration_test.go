package postgres

import (
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The fixture is a real pre-retirement schema, with multiple affected
// subscriptions on one endpoint and a separate unaffected endpoint.
func stepWebhookMigrationFixture(t *testing.T) (*pgxpool.Pool, int) {
	t.Helper()
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 119 })
	if index < 1 {
		t.Fatal("step webhook retirement migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
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
	return pool, index
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
	pool, _ := stepWebhookMigrationFixture(t)
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
	pool, _ := stepWebhookMigrationFixture(t)
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
