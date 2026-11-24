package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestAssistantTaskMigrationsPreserveHistoricalRecords(t *testing.T) {
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	if !t.Run("item lifecycle", func(t *testing.T) {
		ctx := context.Background()
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
	}) {
		return
	}
	if !t.Run("retrospective", func(t *testing.T) {
		ctx := context.Background()
		index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 102 })
		if index < 1 {
			t.Fatal("assistant task retrospective migration is missing")
		}
		if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
			t.Fatal(err)
		}
		task := queryID(1)
		if _, err := pool.Exec(ctx, `INSERT INTO assistant_tasks(id,owner_user_id,request_fingerprint,application,name,purpose,scope,kind,state,takeover,version,manual_version,claim_generation,created_at,updated_at) VALUES($1,$2,'legacy','','Task','Purpose','Scope','continuous','active','manual',3,1,0,statement_timestamp(),statement_timestamp())`, task, queryID(2)); err != nil {
			t.Fatal(err)
		}
		if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
			t.Fatal(err)
		}
		var last *string
		var version int64
		if err := pool.QueryRow(ctx, `SELECT version,last_retrospective_at::text FROM assistant_tasks WHERE id=$1`, task).Scan(&version, &last); err != nil || version != 3 || last != nil {
			t.Fatalf("existing task changed: version=%d last=%v err=%v", version, last, err)
		}
	}) {
		return
	}
	if !t.Run("appendix validation", func(t *testing.T) {
		ctx := context.Background()
		index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 104 })
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
	}) {
		return
	}
}
