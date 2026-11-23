package postgres

import (
	"context"
	"slices"
	"testing"
)

func TestTaskStepsMigrationPreservesExistingTaskAndAddsConstraints(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:29]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	// Seed against the actual pre-030 schema; the current writer requires later
	// lifecycle columns and is not a valid historical migration fixture.
	taskID := queryID(10)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status) VALUES($1,$2,'Task','Description','in_progress')`, taskID, project.ID)
	var before, after string
	if err := pool.QueryRow(ctx, `SELECT `+preCancellationTaskJSON+`::text FROM tasks t WHERE id=$1`, taskID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	end := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 124 })
	if end < 1 {
		t.Fatal("migration 124 missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:end]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT `+preCancellationTaskJSON+`::text FROM tasks t WHERE id=$1`, taskID).Scan(&after); err != nil || before != after {
		t.Fatalf("existing task changed: %v", err)
	}
	assertHistoricalTasksHaveNoCancellationTime(t, database)
	seedHistoricalStep := func(id string, position int64) {
		mustQueryExec(t, database, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,'Coding','## Result','done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z')`, taskID, id, position)
	}
	seedHistoricalStep("00abcdef", 0)
	for _, sql := range []string{
		`INSERT INTO task_steps SELECT task_id,'00ABCDEF',1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',-1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',1,title,description,'review',created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,id,1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',position,title,description,status,created_at,updated_at FROM task_steps`,
	} {
		if _, err := pool.Exec(ctx, sql); err == nil {
			t.Fatalf("constraint accepted: %s", sql)
		}
	}
	seedHistoricalStep("00000001", 1)
	// The unique position constraint is deferred so a single transaction can
	// exchange dense positions without a temporary sentinel.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE task_steps SET position=1-position WHERE task_id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
