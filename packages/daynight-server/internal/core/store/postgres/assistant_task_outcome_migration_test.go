package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestAssistantTaskOutcomeMigrationKeepsExistingRecordsWithoutOutcome(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 97 })
	if index < 1 {
		t.Fatal("assistant task outcome migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	record := queryID(1)
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_task_records(id,owner_user_id,task_id,request_fingerprint,author,kind,text,refs,created_at) VALUES($1,$2,$3,'legacy','system','action','Restarted','[]',statement_timestamp())`, record, queryID(2), queryID(3)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var outcome, action *string
	var kind string
	if err := pool.QueryRow(ctx, `SELECT kind,outcome,action_record_id::text FROM assistant_task_records WHERE id=$1`, record).Scan(&kind, &outcome, &action); err != nil || kind != "action" || outcome != nil || action != nil {
		t.Fatalf("existing record changed: kind=%s outcome=%v action=%v err=%v", kind, outcome, action, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE assistant_task_records SET outcome='effective',action_record_id=$2 WHERE id=$1`, record, queryID(4)); err != nil {
		t.Fatalf("outcome columns are not writable: %v", err)
	}
}
