package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestAssistantTaskRetrospectiveMigrationStartsExistingTasksWithoutAWindow(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 99 })
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
}
