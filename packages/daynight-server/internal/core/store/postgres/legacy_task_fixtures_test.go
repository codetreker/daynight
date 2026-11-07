package postgres

import "testing"

// These migration fixtures own the Task columns present before cancellation.
// Later columns are checked separately instead of changing the historical contract.
const preCancellationTaskJSON = `jsonb_build_object(
    'id',t.id,'project_id',t.project_id,'title',t.title,'description',t.description,
    'status',t.status,'version',t.version,'created_at',t.created_at,'updated_at',t.updated_at,
    'started_at',t.started_at,'completed_at',t.completed_at,'allow_agents',t.allow_agents,
    'required_platform',t.required_platform,'deleted_at',t.deleted_at,'assigned_to',t.assigned_to)`

func preCancellationTaskFactsFixture(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := currentTaskFactsFixture(t, database)
	rows, err := database.Pool.Query(t.Context(), `SELECT id::text,`+preCancellationTaskJSON+`::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, value string
		if err := rows.Scan(&id, &value); err != nil {
			t.Fatal(err)
		}
		facts["task:"+id] = value
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return facts
}

func assertHistoricalTasksHaveNoCancellationTime(t *testing.T, database *Store) {
	t.Helper()
	var count int
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM tasks WHERE cancelled_at IS NOT NULL`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("historical task received cancellation time after upgrade: %d %v", count, err)
	}
}
