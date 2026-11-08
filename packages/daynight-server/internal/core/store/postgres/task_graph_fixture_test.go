package postgres

import (
	"context"
	"fmt"
	"testing"
)

func seedTaskGraph(t *testing.T, database *Store, projectID string, nodes, edges int) {
	t.Helper()
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
  SELECT md5($1::text || ':' || n)::uuid, $1::uuid, 'Task ' || n, '', 'todo', 1,
  statement_timestamp() + n * interval '1 microsecond', statement_timestamp()
  FROM generate_series(1, $2::int) n`, projectID, nodes)
	// Triangular offsets retain the ordered edge prefix without enumerating every pair.
	mustQueryExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(2, $2::bigint) target
  CROSS JOIN LATERAL generate_series(1::bigint,
    LEAST(target - 1, GREATEST(0::bigint, $3::bigint - (target - 1) * (target - 2) / 2))) predecessor`, projectID, nodes, edges)
}

func seedConnectedTaskGraph(t *testing.T, database *Store, projectID string, nodes, edges int) string {
	t.Helper()
	seedTaskGraph(t, database, projectID, nodes, 0)
	// The full chain retains deep traversal; extra convergent edges cross the edge boundary.
	mustQueryExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || n)::uuid, md5($1::text || ':' || (n-1))::uuid
  FROM generate_series(2, $2::int) n`, projectID, nodes)
	mustQueryExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(3, $2::bigint) target
  CROSS JOIN LATERAL generate_series(1::bigint,
    LEAST(target - 2, GREATEST(0::bigint, $3::bigint - (target - 2) * (target - 3) / 2))) predecessor`, projectID, nodes, edges-(nodes-1))
	// A fresh bulk fixture can be queried before autovacuum gathers statistics.
	mustQueryExec(t, database, `ANALYZE tasks, task_dependencies`)
	var rootID string
	if err := database.Pool.QueryRow(context.Background(), `SELECT md5($1::text || ':1')::uuid::text`, projectID).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	return rootID
}

func TestGraphSeedsPreserveOrderedEdgePrefixes(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	for index, test := range []struct {
		nodes, edges int
		connected    bool
	}{
		{1, 0, false}, {8, 0, false}, {8, 1, false}, {8, 3, false},
		{8, 5, false}, {8, 28, false}, {8, 7, true}, {8, 8, true},
		{8, 12, true}, {8, 28, true},
	} {
		t.Run(fmt.Sprintf("%d_%d_connected_%t", test.nodes, test.edges, test.connected), func(t *testing.T) {
			project := queryProject(t, database, index+1)
			extra := test.edges
			if test.connected {
				seedConnectedTaskGraph(t, database, project.ID, test.nodes, test.edges)
				extra -= test.nodes - 1
			} else {
				seedTaskGraph(t, database, project.ID, test.nodes, test.edges)
			}
			var differences int
			err := database.Pool.QueryRow(ctx, `WITH expected AS (
  SELECT md5($1::text || ':' || target)::uuid AS task_id,
         md5($1::text || ':' || predecessor)::uuid AS depends_on_task_id
  FROM (
    SELECT target, predecessor FROM generate_series(1, $2::int) target
    CROSS JOIN generate_series(1, $2::int) predecessor
    WHERE predecessor < target - CASE WHEN $4::boolean THEN 1 ELSE 0 END
    ORDER BY target, predecessor LIMIT $3
  ) pairs
  UNION ALL
  SELECT md5($1::text || ':' || n)::uuid, md5($1::text || ':' || (n-1))::uuid
  FROM generate_series(2, $2::int) n WHERE $4::boolean
), actual AS (
  SELECT task_id, depends_on_task_id FROM task_dependencies WHERE project_id=$1::uuid
)
SELECT count(*) FROM (
  (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  UNION ALL
  (SELECT * FROM actual EXCEPT SELECT * FROM expected)
) difference`, project.ID, test.nodes, extra, test.connected).Scan(&differences)
			if err != nil || differences != 0 {
				t.Fatalf("seed differs from ordered edge prefix: differences=%d, error=%v", differences, err)
			}
		})
	}
}
