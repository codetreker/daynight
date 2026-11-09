package task_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskGraphProjectionAndUnicodeBounds(t *testing.T) {
	s := readerStore(t)
	ctx := context.Background()
	project, other := readerProject(t, s, 1), readerProject(t, s, 2)
	readerTask(t, s, other.ID, 19, model.TaskTodo)
	done := readerTask(t, s, project.ID, 10, model.TaskDone)
	pending := readerTask(t, s, project.ID, 11, model.TaskTodo)
	blocked := readerTask(t, s, project.ID, 12, model.TaskTodo, pending.ID, done.ID)
	active := readerTask(t, s, project.ID, 13, model.TaskInProgress, done.ID)
	waiting := readerTask(t, s, project.ID, 14, model.TaskTodo, done.ID)
	waitingBlocked := readerTask(t, s, project.ID, 15, model.TaskTodo, pending.ID)
	titles := []string{strings.Repeat("汉", 160), strings.Repeat("😀", 161), strings.Repeat("e\u0301", 81), "Plain title", "Waiting", "Waiting with prerequisite"}
	for index, task := range []model.Task{done, pending, blocked, active, waiting, waitingBlocked} {
		readerExec(t, s, "UPDATE tasks SET title = $1 WHERE id = $2", titles[index], task.ID)
	}
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	readerExec(t, s, "UPDATE tasks SET created_at = $1 WHERE project_id = $2", stamp, project.ID)
	// A failing description expression ensures the graph never materializes full task details.
	readerExec(t, s, `CREATE FUNCTION reject_description() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'description must not be selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, title, reject_description() AS description,
		status, version, created_at, updated_at, started_at, completed_at, cancelled_at, allow_agents, required_platform, assigned_to, deleted_at FROM task_source`)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, readerID(11), readerGraphSelection(), 160)
		if err != nil || len(tasks) != 6 {
			t.Fatalf("graph tasks: %#v, %v", tasks, err)
		}
		for index, task := range tasks {
			wantPreview := []rune(titles[index])
			truncated := len(wantPreview) > 160
			if truncated {
				wantPreview = wantPreview[:160]
			}
			if task.ID != readerID(index+10) || task.TitlePreview != string(wantPreview) || task.TitleTruncated != truncated ||
				utf8.RuneCountInString(task.TitlePreview) > 160 || task.CreatedAt != stamp || task.UpdatedAt.Location() != time.UTC ||
				task.DependsOn == nil || task.BlockedBy == nil {
				t.Fatalf("bounded projection %d: %#v", index, task)
			}
		}
		if tasks[0].Ready || !tasks[1].Ready || tasks[2].Ready || tasks[3].Ready || !tasks[4].Ready || tasks[5].Ready ||
			!slices.Equal(tasks[2].DependsOn, []string{done.ID, pending.ID}) ||
			!slices.Equal(tasks[2].BlockedBy, []string{pending.ID}) || len(tasks[3].BlockedBy) != 0 || len(tasks[4].BlockedBy) != 0 ||
			!slices.Equal(tasks[5].BlockedBy, []string{pending.ID}) || tasks[4].Status != model.TaskTodo || tasks[5].Status != model.TaskTodo {
			t.Fatalf("graph derived fields: %#v", tasks)
		}
		empty, err := snapshot.TaskDAO().TaskGraphTasks(ctx, readerID(999), readerID(11), readerGraphSelection(), 160)
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty graph slice: %#v, %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskGraphStoreFailuresPreserveCauses(t *testing.T) {
	for _, test := range []struct {
		name string
		ddl  string
	}{
		{"query", "DROP TABLE tasks"},
		{"decode", `ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, status, 1::bigint AS created_at, updated_at, started_at, completed_at, cancelled_at, allow_agents, required_platform, assigned_to, deleted_at FROM task_source`},
		{"iteration", `CREATE FUNCTION fail_graph_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'private graph failure'; END $$;
			ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, status, created_at, fail_graph_stamp() AS updated_at, started_at, completed_at, cancelled_at, allow_agents, required_platform, assigned_to, deleted_at FROM task_source`},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := readerStore(t)
			project := readerProject(t, s, 1)
			readerTask(t, s, project.ID, 11, model.TaskTodo)
			readerExec(t, s, test.ddl)
			err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
				_, err := snapshot.TaskDAO().TaskGraphTasks(context.Background(), project.ID, readerID(11), readerGraphSelection(), 160)
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "private graph") {
				t.Fatalf("graph query failure was hidden or leaked: %v", err)
			}
			if test.name == "iteration" {
				var pgError *pgconn.PgError
				if !errors.As(err, &pgError) || pgError.Code != "P1003" {
					t.Fatalf("iteration cause lost: %v", err)
				}
			}
		})
	}
}

func TestTaskGraphPresenceKeepsProjectAndDeletionFacts(t *testing.T) {
	database := readerStore(t)
	ctx := t.Context()
	project, other := readerProject(t, database, 1), readerProject(t, database, 2)
	target := readerTask(t, database, project.ID, 11, model.TaskTodo)
	foreign := readerTask(t, database, other.ID, 21, model.TaskTodo)
	detached := readerTask(t, database, project.ID, 12, model.TaskTodo)
	readerTask(t, database, project.ID, 13, model.TaskTodo, detached.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, target.ID, readerGraphSelection(), 160)
		if err != nil || len(tasks) != 1 || tasks[0].ID != target.ID {
			t.Fatalf("isolated graph lost its root: %#v %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	read := func(id string, found, deleted bool) {
		t.Helper()
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			presence, err := snapshot.TaskDAO().TaskPresence(ctx, project.ID, id)
			if err != nil || presence.Found != found || (presence.DeletedAt != nil) != deleted {
				t.Fatalf("graph presence %s: %#v %v", id, presence, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	read(target.ID, true, false)
	read(readerID(99), false, false)
	read(foreign.ID, false, false)
	readerExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE project_id=$1 AND id=$2`, project.ID, target.ID)
	read(target.ID, true, true)
}

func TestTaskGraphStoreSelectsOrdinaryComponentAndDirectExternalContext(t *testing.T) {
	database := readerStore(t)
	ctx := context.Background()
	project := readerProject(t, database, 1)
	y := readerTask(t, database, project.ID, 10, model.TaskTodo)
	x := readerTask(t, database, project.ID, 11, model.TaskTodo, y.ID)
	readerTask(t, database, project.ID, 12, model.TaskTodo, x.ID)
	a := readerTask(t, database, project.ID, 20, model.TaskTodo)
	b := readerTask(t, database, project.ID, 21, model.TaskTodo, a.ID, x.ID)
	c := readerTask(t, database, project.ID, 22, model.TaskTodo, a.ID)
	d := readerTask(t, database, project.ID, 23, model.TaskTodo, b.ID, c.ID)
	reverse := readerTask(t, database, project.ID, 30, model.TaskTodo, b.ID)
	readerExec(t, database, `UPDATE task_dependencies SET external=true
  WHERE project_id=$1 AND ((task_id=$2 AND depends_on_task_id=$3) OR (task_id=$4 AND depends_on_task_id=$2) OR (task_id=$5 AND depends_on_task_id=$4))`, project.ID, x.ID, y.ID, b.ID, reverse.ID)
	for _, seed := range []model.Task{a, b, c, d} {
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, seed.ID, readerGraphSelection(), 160)
			if err != nil {
				return err
			}
			var ids []string
			for _, task := range tasks {
				ids = append(ids, task.ID)
			}
			if !slices.Equal(ids, []string{x.ID, a.ID, b.ID, c.ID, d.ID}) {
				t.Fatalf("ordinary component expanded external or reverse context: %#v", ids)
			}
			if !slices.Equal(tasks[0].DependsOn, []string{y.ID}) || !slices.Equal(tasks[0].ExternalDependsOn, []string{y.ID}) || !slices.Equal(tasks[0].BlockedBy, []string{y.ID}) || tasks[0].Ready {
				t.Fatalf("unexpanded external context lost raw dependencies or blockers: %#v", tasks[0])
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		selection := readerGraphSelection()
		selection.DirectExternal = false
		tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, a.ID, selection, 160)
		if err != nil || len(tasks) != 4 || tasks[0].ID != a.ID || tasks[3].ID != d.ID {
			t.Fatalf("without direct external: %+v %v", tasks, err)
		}
		selection.DirectExternal = true
		selection.OrdinaryDependents = false
		tasks, err = snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, b.ID, selection, 160)
		if err != nil || len(tasks) != 3 || tasks[0].ID != x.ID || tasks[1].ID != a.ID || tasks[2].ID != b.ID {
			t.Fatalf("prerequisites only: %+v %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

}

func readerGraphSelection() TaskGraphSelection {
	return TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
}

func seedTaskGraph(t *testing.T, database *postgres.Store, projectID string, nodes, edges int) {
	t.Helper()
	readerExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
  SELECT md5($1::text || ':' || n)::uuid, $1::uuid, 'Task ' || n, '', 'todo', 1,
  statement_timestamp() + n * interval '1 microsecond', statement_timestamp()
  FROM generate_series(1, $2::int) n`, projectID, nodes)
	// Triangular offsets retain the ordered edge prefix without enumerating every pair.
	readerExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(2, $2::bigint) target
  CROSS JOIN LATERAL generate_series(1::bigint,
    LEAST(target - 1, GREATEST(0::bigint, $3::bigint - (target - 1) * (target - 2) / 2))) predecessor`, projectID, nodes, edges)
}

func seedConnectedTaskGraph(t *testing.T, database *postgres.Store, projectID string, nodes, edges int) string {
	t.Helper()
	seedTaskGraph(t, database, projectID, nodes, 0)
	// The full chain retains deep traversal; extra convergent edges cross the edge boundary.
	readerExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || n)::uuid, md5($1::text || ':' || (n-1))::uuid
  FROM generate_series(2, $2::int) n`, projectID, nodes)
	readerExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(3, $2::bigint) target
  CROSS JOIN LATERAL generate_series(1::bigint,
    LEAST(target - 2, GREATEST(0::bigint, $3::bigint - (target - 2) * (target - 3) / 2))) predecessor`, projectID, nodes, edges-(nodes-1))
	// A fresh bulk fixture can be queried before autovacuum gathers statistics.
	readerExec(t, database, `ANALYZE tasks, task_dependencies`)
	var rootID string
	if err := database.Pool.QueryRow(context.Background(), `SELECT md5($1::text || ':1')::uuid::text`, projectID).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	return rootID
}

func TestGraphSeedsPreserveOrderedEdgePrefixes(t *testing.T) {
	database := readerStore(t)
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
			project := readerProject(t, database, index+1)
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
