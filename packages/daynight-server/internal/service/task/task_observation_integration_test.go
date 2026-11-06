package task_test

import (
	"context"
	"strings"
	"testing"
)

func TestTaskObservationKeepsEpochAndTaskInOneSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	target := createTask(t, tasks, principal, project.ID, "Before replacement")
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "FROM tasks t") },
		end: func() {
			tx, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `UPDATE tasks SET title='After replacement' WHERE id=$1`, target.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec(ctx, `UPDATE projects SET task_cache_epoch=gen_random_uuid() WHERE id=$1`, project.ID); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		},
	})
	old, err := traced.Observe(ctx, principal, project.ID, target.ID)
	if err != nil || old.Task.Title != target.Title || old.Epoch != before {
		t.Fatalf("mixed snapshot: %#v, %v", old, err)
	}
	fresh, err := tasks.Observe(ctx, principal, project.ID, target.ID)
	if err != nil || fresh.Task.Title != "After replacement" || fresh.Epoch == before || fresh.Task.Version != target.Version {
		t.Fatalf("replacement not observed: %#v, %v", fresh, err)
	}
}
