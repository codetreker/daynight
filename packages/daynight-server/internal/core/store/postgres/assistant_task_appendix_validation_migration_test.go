package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestAssistantTaskAppendixValidationMigrationLeavesExistingAppendicesUnrestricted(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 102 })
	if index < 1 {
		t.Fatal("assistant task appendix validation migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	appendix := queryID(1)
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_task_appendix(id,owner_user_id,task_id,request_fingerprint,text,source_records,state,version,created_at,updated_at) VALUES($1,$2,$3,'legacy','Lesson','[]','active',1,statement_timestamp(),statement_timestamp())`, appendix, queryID(2), queryID(3)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var projects, events, categories string
	var successes, failures int64
	var validated *string
	if err := pool.QueryRow(ctx, `SELECT scope_project_ids::text,scope_event_types::text,scope_item_categories::text,success_count,failure_count,last_validated_at::text FROM assistant_task_appendix WHERE id=$1`, appendix).Scan(&projects, &events, &categories, &successes, &failures, &validated); err != nil {
		t.Fatal(err)
	}
	if projects != "[]" || events != "[]" || categories != "[]" || successes != 0 || failures != 0 || validated != nil {
		t.Fatalf("existing appendix gained scope or validations: %s %s %s %d %d %v", projects, events, categories, successes, failures, validated)
	}
	insert := `INSERT INTO assistant_task_appendix_validations(owner_user_id,task_id,appendix_id,outcome_record_id,outcome,validator_bot_id,created_at) VALUES($1,$2,$3,$4,'effective',$5,statement_timestamp())`
	if _, err := pool.Exec(ctx, insert, queryID(2), queryID(3), appendix, queryID(4), queryID(5)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, queryID(2), queryID(3), appendix, queryID(4), queryID(6)); err == nil {
		t.Fatal("duplicate validation of one outcome record was accepted")
	}
}
