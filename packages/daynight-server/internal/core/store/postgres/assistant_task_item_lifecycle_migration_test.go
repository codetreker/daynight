package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestAssistantTaskItemLifecycleMigrationDoesNotBackfillExistingItems(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 101 })
	if index < 1 {
		t.Fatal("assistant task item lifecycle migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	item := queryID(1)
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_task_items(id,owner_user_id,task_id,request_fingerprint,key,episode,state,category,app_state,version,created_at,updated_at) VALUES($1,$2,$3,'legacy','build',1,'open','','{}',1,statement_timestamp(),statement_timestamp())`, item, queryID(2), queryID(3)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var opened, closed *string
	var state string
	if err := pool.QueryRow(ctx, `SELECT state,opened_at::text,closed_at::text FROM assistant_task_items WHERE id=$1`, item).Scan(&state, &opened, &closed); err != nil || state != "open" || opened != nil || closed != nil {
		t.Fatalf("existing item changed: state=%s opened=%v closed=%v err=%v", state, opened, closed, err)
	}
	var closures int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_item_closures`).Scan(&closures); err != nil || closures != 0 {
		t.Fatalf("migration recorded closures: %d %v", closures, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_task_item_closures(id,owner_user_id,task_id,item_id,episode,opened_at,closed_at) VALUES($1,$2,$3,$4,1,NULL,statement_timestamp())`, queryID(4), queryID(2), queryID(3), item); err != nil {
		t.Fatalf("closure without an opening time is not writable: %v", err)
	}
}
