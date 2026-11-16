package postgres

import "testing"

func TestPreviewSSOMigrationPreservesSessions(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) < 75 || schemaMigrations[73].version != 74 || schemaMigrations[74].version != 75 {
		t.Fatal("preview migration must follow version 74")
	}
	if err := migrate(ctx, pool, schemaMigrations[:74]); err != nil {
		t.Fatal(err)
	}
	id, user := queryID(1), queryID(2)
	_, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, id, user, deviceStoreHash("existing"))
	if err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var found, empty bool
	err = pool.QueryRow(ctx, `SELECT user_id=$2 AND token_hash=$3,preview_token_hash IS NULL FROM sessions WHERE id=$1`, id, user, deviceStoreHash("existing")).Scan(&found, &empty)
	if err != nil || !found || !empty {
		t.Fatalf("existing session changed: found=%v empty=%v err=%v", found, empty, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, queryID(3), user, deviceStoreHash("second"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE sessions SET preview_token_hash=$2 WHERE id=$1`, id, deviceStoreHash("preview"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE sessions SET preview_token_hash=$2 WHERE id=$1`, queryID(3), deviceStoreHash("preview"))
	if err == nil {
		t.Fatal("duplicate preview credential accepted")
	}
	if err = migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=75`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("migration ledger: count=%d err=%v", count, err)
	}
}
