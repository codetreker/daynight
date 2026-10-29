package store

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskGraphProjectionAndUnicodeBounds(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project, other := queryProject(t, s, 1), queryProject(t, s, 2)
	queryTask(t, s, other.ID, 19, core.TaskTodo)
	done := queryTask(t, s, project.ID, 10, core.TaskDone)
	pending := queryTask(t, s, project.ID, 11, core.TaskTodo)
	blocked := queryTask(t, s, project.ID, 12, core.TaskTodo, pending.ID, done.ID)
	active := queryTask(t, s, project.ID, 13, core.TaskInProgress, done.ID)
	waiting := queryTask(t, s, project.ID, 14, core.TaskTodo, done.ID)
	waitingBlocked := queryTask(t, s, project.ID, 15, core.TaskTodo, pending.ID)
	titles := []string{strings.Repeat("汉", 160), strings.Repeat("😀", 161), strings.Repeat("e\u0301", 81), "Plain title", "Waiting", "Waiting with prerequisite"}
	for index, task := range []core.Task{done, pending, blocked, active, waiting, waitingBlocked} {
		mustQueryExec(t, s, "UPDATE tasks SET title = $1, description = repeat('large description', 100000) WHERE id = $2", titles[index], task.ID)
	}
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	mustQueryExec(t, s, "UPDATE tasks SET created_at = $1 WHERE project_id = $2", stamp, project.ID)
	// A failing description expression ensures the graph never materializes full task details.
	mustQueryExec(t, s, `CREATE FUNCTION reject_description() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'description must not be selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, title, reject_description() AS description,
		status, version, created_at, updated_at, started_at, completed_at, allow_agents, required_platform, deleted_at FROM task_source`)
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		size, err := snapshot.TaskGraphProjectionSize(ctx, project.ID, pending.ID)
		if err != nil || size != (TaskGraphSize{NodeCount: 6, EdgeCount: 5}) {
			t.Fatalf("scoped size: %#v, %v", size, err)
		}
		tasks, err := snapshot.TaskGraphTasks(ctx, project.ID, queryID(11), 160)
		if err != nil || len(tasks) != 6 {
			t.Fatalf("graph tasks: %#v, %v", tasks, err)
		}
		for index, task := range tasks {
			wantPreview := []rune(titles[index])
			truncated := len(wantPreview) > 160
			if truncated {
				wantPreview = wantPreview[:160]
			}
			if task.ID != queryID(index+10) || task.TitlePreview != string(wantPreview) || task.TitleTruncated != truncated ||
				utf8.RuneCountInString(task.TitlePreview) > 160 || task.CreatedAt != stamp || task.UpdatedAt.Location() != time.UTC ||
				task.DependsOn == nil || task.BlockedBy == nil {
				t.Fatalf("bounded projection %d: %#v", index, task)
			}
		}
		if tasks[0].Ready || !tasks[1].Ready || tasks[2].Ready || tasks[3].Ready || !tasks[4].Ready || tasks[5].Ready ||
			!slices.Equal(tasks[2].DependsOn, []string{done.ID, pending.ID}) ||
			!slices.Equal(tasks[2].BlockedBy, []string{pending.ID}) || len(tasks[3].BlockedBy) != 0 || len(tasks[4].BlockedBy) != 0 ||
			!slices.Equal(tasks[5].BlockedBy, []string{pending.ID}) || tasks[4].Status != core.TaskTodo || tasks[5].Status != core.TaskTodo {
			t.Fatalf("graph derived fields: %#v", tasks)
		}
		empty, err := snapshot.TaskGraphTasks(ctx, queryID(999), queryID(11), 160)
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty graph slice: %#v, %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskGraphCountAndProjectionShareSnapshot(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	a := queryTask(t, s, project.ID, 11, core.TaskTodo)
	b := queryTask(t, s, project.ID, 12, core.TaskTodo, a.ID)
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if _, err := snapshot.Project(ctx, project.ID); err != nil {
			return err
		}
		before, err := snapshot.TaskGraphProjectionSize(ctx, project.ID, a.ID)
		if err != nil {
			return err
		}
		if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
			if _, err := tx.UpdateTask(ctx, a.ID, TaskWrite{Title: "Changed", Status: core.TaskDone}); err != nil {
				return err
			}
			_, err := tx.CreateTask(ctx, queryID(13), TaskWrite{Title: "New", Status: core.TaskTodo, DependsOn: []string{b.ID}})
			return err
		}); err != nil {
			return err
		}
		after, err := snapshot.TaskGraphProjectionSize(ctx, project.ID, a.ID)
		if err != nil || before != (TaskGraphSize{2, 1}) || after != before {
			t.Fatalf("count mixed snapshots: before %#v after %#v, %v", before, after, err)
		}
		tasks, err := snapshot.TaskGraphTasks(ctx, project.ID, queryID(11), 160)
		if err != nil || len(tasks) != 2 || tasks[0].TitlePreview != a.Title || tasks[0].Status != core.TaskTodo ||
			!reflect.DeepEqual(tasks[1].BlockedBy, []string{a.ID}) || tasks[1].Ready {
			t.Fatalf("projection mixed snapshots: %#v, %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskGraphStoreFailuresPreserveCauses(t *testing.T) {
	for _, test := range []struct {
		name  string
		ddl   string
		count bool
	}{
		{"count", "DROP TABLE task_dependencies", true},
		{"projection count", "DROP TABLE task_dependencies", true},
		{"query", "DROP TABLE tasks", false},
		{"decode", `ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, status, 1::bigint AS created_at, updated_at, started_at, completed_at, allow_agents, required_platform, deleted_at FROM task_source`, false},
		{"iteration", `CREATE FUNCTION fail_graph_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'private graph failure'; END $$;
			ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, status, created_at, fail_graph_stamp() AS updated_at, started_at, completed_at, allow_agents, required_platform, deleted_at FROM task_source`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			project := queryProject(t, s, 1)
			queryTask(t, s, project.ID, 11, core.TaskTodo)
			mustQueryExec(t, s, test.ddl)
			err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
				if test.count {
					if test.name == "count" {
						_, err := snapshot.TaskGraphSize(context.Background(), project.ID)
						return err
					}
					_, err := snapshot.TaskGraphProjectionSize(context.Background(), project.ID, queryID(11))
					return err
				}
				_, err := snapshot.TaskGraphTasks(context.Background(), project.ID, queryID(11), 160)
				return err
			})
			if err == nil || errors.Is(err, core.ErrNotFound) || strings.Contains(err.Error(), "private graph") {
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

func TestTaskGraphRootRequiresLiveProjectScopedTask(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project, other := queryProject(t, database, 1), queryProject(t, database, 2)
	root := queryTask(t, database, project.ID, 11, core.TaskTodo)
	foreign := queryTask(t, database, other.ID, 21, core.TaskTodo)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error { return snapshot.TaskGraphRoot(ctx, project.ID, root.ID) }); err != nil {
		t.Fatalf("live graph root refused: %v", err)
	}
	for _, id := range []string{queryID(99), foreign.ID} {
		err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error { return snapshot.TaskGraphRoot(ctx, project.ID, id) })
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("missing or cross-project graph root exposed: %v", err)
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE project_id=$1 AND id=$2`, project.ID, root.ID)
	err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error { return snapshot.TaskGraphRoot(ctx, project.ID, root.ID) })
	if !errors.Is(err, core.ErrTaskDeleted) {
		t.Fatalf("deleted graph root lost deletion marker: %v", err)
	}
}

func TestTaskGraphStoreSelectsOrdinaryComponentAndDirectExternalContext(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	y := queryTask(t, database, project.ID, 10, core.TaskTodo)
	x := queryTask(t, database, project.ID, 11, core.TaskTodo, y.ID)
	queryTask(t, database, project.ID, 12, core.TaskTodo, x.ID)
	a := queryTask(t, database, project.ID, 20, core.TaskTodo)
	b := queryTask(t, database, project.ID, 21, core.TaskTodo, a.ID, x.ID)
	c := queryTask(t, database, project.ID, 22, core.TaskTodo, a.ID)
	d := queryTask(t, database, project.ID, 23, core.TaskTodo, b.ID, c.ID)
	reverse := queryTask(t, database, project.ID, 30, core.TaskTodo, b.ID)
	mustQueryExec(t, database, `UPDATE task_dependencies SET external=true
  WHERE project_id=$1 AND ((task_id=$2 AND depends_on_task_id=$3) OR (task_id=$4 AND depends_on_task_id=$2) OR (task_id=$5 AND depends_on_task_id=$4))`, project.ID, x.ID, y.ID, b.ID, reverse.ID)
	for _, seed := range []core.Task{a, b, c, d} {
		if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			size, err := snapshot.TaskGraphProjectionSize(ctx, project.ID, seed.ID)
			if err != nil || size != (TaskGraphSize{NodeCount: 5, EdgeCount: 6}) {
				t.Fatalf("scoped graph counted unrelated nodes or lost raw context edges: %#v %v", size, err)
			}
			tasks, err := snapshot.TaskGraphTasks(ctx, project.ID, seed.ID, 160)
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
}
