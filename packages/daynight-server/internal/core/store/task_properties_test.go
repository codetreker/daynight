package store

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestTaskPropertiesMigrationPreservesExistingResource(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:2]); err != nil {
		t.Fatal(err)
	}
	projectID, taskID := queryID(1), queryID(2)
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	updated := created.Add(time.Hour)
	if _, err := pool.Exec(ctx, "INSERT INTO projects (id,name,repo_url) VALUES ($1,'Existing','host:repo')", projectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tasks (id,project_id,title,description,status,version,created_at,updated_at)
		VALUES ($1,$2,'Existing task','Existing description','done',17,$3,$4)`, taskID, projectID, created, updated); err != nil {
		t.Fatal(err)
	}
	var missing bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&missing); err != nil || !missing {
		t.Fatalf("fixture was not an actual old schema: %v, %v", missing, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	task := snapshotTask(t, database, projectID, taskID)
	if task.Title != "Existing task" || task.Description != "Existing description" || task.Status != core.TaskDone || task.Version != 17 || !task.CreatedAt.Equal(created) || !task.UpdatedAt.Equal(updated) || fixturePullRequests(t, task.Properties) == nil || len(fixturePullRequests(t, task.Properties)) != 0 {
		t.Fatalf("migration changed old resource: %#v", task)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=3").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=3").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotTask(t, database, projectID, taskID), task) {
		t.Fatalf("repeated migration changed ledger/resource: %v, %v", after, err)
	}
}
