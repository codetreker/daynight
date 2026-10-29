package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func seedGraph(t *testing.T, database *store.Store, projectID string, nodes, edges int) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
		SELECT md5($1::text || ':' || n)::uuid, $1::uuid, 'Task ' || n, '', 'todo', 1,
		statement_timestamp() + n * interval '1 microsecond', statement_timestamp()
		FROM generate_series(1, $2::int) n`, projectID, nodes); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
		SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
		FROM generate_series(1, $2::int) target CROSS JOIN generate_series(1, $2::int) predecessor
		WHERE predecessor < target ORDER BY target, predecessor LIMIT $3`, projectID, nodes, edges); err != nil {
		t.Fatal(err)
	}
}

func seedConnectedGraph(t *testing.T, database *store.Store, projectID string, nodes, edges int) string {
	t.Helper()
	ctx := context.Background()
	seedGraph(t, database, projectID, nodes, 0)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || n)::uuid, md5($1::text || ':' || (n-1))::uuid
  FROM generate_series(2, $2::int) n`, projectID, nodes); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(1, $2::int) target CROSS JOIN generate_series(1, $2::int) predecessor
  WHERE predecessor < target-1 ORDER BY target, predecessor LIMIT $3`, projectID, nodes, edges-(nodes-1)); err != nil {
		t.Fatal(err)
	}
	var rootID string
	if err := database.Pool.QueryRow(ctx, `SELECT md5($1::text || ':1')::uuid::text`, projectID).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	return rootID
}

func TestTaskGraphScopedProjectionAndSummary(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	_, err := tasks.Graph(ctx, principal, strings.ToUpper(project.ID), "00000000-0000-4000-8000-000000000099")
	requireFault(t, err, "not_found")
	other, err := NewProjects(database).Create(ctx, principal, CreateProject{Name: "Other", RepoURL: "host:other"})
	if err != nil {
		t.Fatal(err)
	}
	createTask(t, tasks, principal, other.ID, "Out of scope")
	done := createTask(t, tasks, principal, project.ID, "Done")

	done = startTask(t, tasks, principal, done)
	done = finishTask(t, tasks, principal, done)
	active := createTask(t, tasks, principal, project.ID, "Active", done.ID)

	active = startTask(t, tasks, principal, active)
	ready := createTask(t, tasks, principal, project.ID, "Ready", done.ID)

	blocked := createTask(t, tasks, principal, project.ID, "Blocked", active.ID, ready.ID)

	queued := createTask(t, tasks, principal, project.ID, "Queued", done.ID)
	queuedBlocked := createTask(t, tasks, principal, project.ID, "Queued blocked", active.ID)
	graph, err := tasks.Graph(ctx, principal, project.ID, done.ID)
	wantSummary := core.TaskGraphSummary{Total: 6, Todo: 4, InProgress: 1, Done: 1, Ready: 2, Blocked: 2}
	if err != nil || graph.Summary != wantSummary || len(graph.Tasks) != 6 || !reflect.DeepEqual(graph.Project, project) {
		t.Fatalf("complete graph: %#v, %v", graph, err)
	}
	for index, original := range []core.Task{done, active, ready, blocked, queued, queuedBlocked} {
		got := graph.Tasks[index]
		if got.ID != original.ID || got.TitlePreview != original.Title || got.TitleTruncated || got.Status != original.Status ||
			!slices.Equal(got.DependsOn, original.DependsOn) || !slices.Equal(got.BlockedBy, original.BlockedBy) || got.Ready != original.Ready ||
			!got.CreatedAt.Equal(original.CreatedAt) || !got.UpdatedAt.Equal(original.UpdatedAt) {
			t.Fatalf("projection differs from task %d: %#v versus %#v", index, got, original)
		}
	}
	_, err = tasks.Graph(ctx, principal, "invalid", done.ID)
	requireFault(t, err, "invalid_input")
	_, err = tasks.Graph(ctx, principal, "00000000-0000-0000-0000-000000000000", done.ID)
	fault := requireFault(t, err, "not_found")
	if !errors.Is(fault, core.ErrNotFound) || fault.GraphLimit != nil {
		t.Fatalf("missing graph cause: %#v", fault)
	}
}

func TestTaskGraphExactLimitsAndIndependentRejections(t *testing.T) {
	for _, test := range []struct {
		nodes, edges int
		refused      bool
	}{
		{1000, 5000, false}, {1001, 1000, true}, {101, 5001, true},
	} {
		t.Run(fmt.Sprintf("%d_nodes_%d_edges", test.nodes, test.edges), func(t *testing.T) {
			_, database, project, databaseURL, principal := taskService(t)
			rootID := seedConnectedGraph(t, database, project.ID, test.nodes, test.edges)
			readProjection := false
			traced := tracedTasks(t, databaseURL, taskQueryAction{
				match: func(sql string) bool { return strings.Contains(sql, "left(t.title, $3)") },
				start: func() { readProjection = true },
			})
			graph, err := traced.Graph(context.Background(), principal, project.ID, rootID)
			if test.refused {
				fault := requireFault(t, err, "graph_limit_exceeded")
				want := &GraphLimitDetails{NodeCount: int64(test.nodes), EdgeCount: int64(test.edges), MaxNodes: 1000, MaxEdges: 5000}
				if !reflect.DeepEqual(fault.GraphLimit, want) || readProjection || !reflect.DeepEqual(graph, core.TaskGraph{}) {
					t.Fatalf("limit returned partial data or inaccurate counts: %#v, %#v, read %v", fault, graph, readProjection)
				}
				return
			}
			if err != nil || len(graph.Tasks) != test.nodes || !readProjection || graph.Summary.Total != 1000 || graph.Summary.Todo != 1000 {
				t.Fatalf("exact limit rejected: tasks %d, summary %#v, %v", len(graph.Tasks), graph.Summary, err)
			}
			edges := 0
			for _, task := range graph.Tasks {
				edges += len(task.DependsOn)
			}
			if edges != 5000 || graph.Summary.Ready+graph.Summary.Blocked != 1000 {
				t.Fatalf("exact limit truncated: edges %d, %#v", edges, graph.Summary)
			}
		})
	}
}

func TestTaskGraphInterleavedWriteKeepsOneSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	predecessor := createTask(t, tasks, principal, project.ID, "Predecessor")

	dependent := createTask(t, tasks, principal, project.ID, "Dependent", predecessor.ID)

	writes := 0
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "SELECT count(*) FROM selected") },
		end: func() {
			writes++
			if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
				if _, err := tx.UpdateTask(ctx, predecessor.ID, store.TaskWrite{Title: "Completed", Status: core.TaskDone}); err != nil {
					return err
				}
				_, err := tx.CreateTask(ctx, "00000000-0000-4000-8000-000000000001", store.TaskWrite{Title: "New", Status: core.TaskTodo, DependsOn: []string{dependent.ID}})
				return err
			}); err != nil {
				t.Fatal(err)
			}
		},
	})
	old, err := traced.Graph(ctx, principal, project.ID, predecessor.ID)
	if err != nil || writes != 1 || len(old.Tasks) != 2 || old.Tasks[0].TitlePreview != predecessor.Title || old.Tasks[0].Status != core.TaskTodo ||
		old.Tasks[1].Ready || !slices.Equal(old.Tasks[1].BlockedBy, []string{predecessor.ID}) || old.Summary != (core.TaskGraphSummary{Total: 2, Todo: 2, Ready: 1, Blocked: 1}) {
		t.Fatalf("mixed snapshot: %#v, writes %d, %v", old, writes, err)
	}
	fresh, err := tasks.Graph(ctx, principal, project.ID, predecessor.ID)
	if err != nil || len(fresh.Tasks) != 3 || fresh.Tasks[0].TitlePreview != "Completed" || !fresh.Tasks[1].Ready ||
		fresh.Summary != (core.TaskGraphSummary{Total: 3, Todo: 2, Done: 1, Ready: 1, Blocked: 1}) {
		t.Fatalf("fresh snapshot: %#v, %v", fresh, err)
	}
}

func TestTaskGraphOperationalFailuresAndCompletionPrecedence(t *testing.T) {
	for _, test := range []struct {
		name, fragment                  string
		missing, overLimit, cancelAfter bool
	}{
		{name: "project query", fragment: "FROM projects WHERE id ="},
		{name: "count query", fragment: "SELECT count(*) FROM selected"},
		{name: "projection query", fragment: "left(t.title, $3)"},
		{name: "clock query", fragment: "SELECT statement_timestamp()"},
		{name: "clock completion", fragment: "SELECT statement_timestamp()", cancelAfter: true},
		{name: "missing project completion", fragment: "FROM project_members m", missing: true, cancelAfter: true},
		{name: "limit refusal completion", fragment: "SELECT count(*) FROM selected", overLimit: true, cancelAfter: true},
		{name: "success completion", fragment: "left(t.title, $3)", cancelAfter: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, database, project, databaseURL, principal := taskService(t)
			rootID := "00000000-0000-4000-8000-000000000099"
			if test.overLimit {
				rootID = seedConnectedGraph(t, database, project.ID, 1001, 1000)
			} else {
				rootID = createTask(t, NewTasks(database), principal, project.ID, "Snapshot root").ID
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }}
			if test.cancelAfter {
				action.end = cancel
			} else {
				action.start = cancel
			}
			traced := tracedTasks(t, databaseURL, action)
			id := project.ID
			if test.missing {
				id = "00000000-0000-0000-0000-000000000000"
			}
			graph, err := traced.Graph(ctx, principal, id, rootID)
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(graph, core.TaskGraph{}) {
				t.Fatalf("cancellation cause or partial result: %#v, %v", graph, err)
			}
		})
	}
	for _, table := range []string{"projects", "tasks", "task_dependencies"} {
		t.Run("missing "+table, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			root := createTask(t, tasks, principal, project.ID, "Failure root")
			if _, err := database.Pool.Exec(context.Background(), "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			_, err := tasks.Graph(context.Background(), principal, project.ID, root.ID)
			assertOperational(t, err)
		})
	}
	tasks, database, project, _, principal := taskService(t)
	root := createTask(t, tasks, principal, project.ID, "Closed store root")
	database.Close()
	_, err := tasks.Graph(context.Background(), principal, project.ID, root.ID)
	assertOperational(t, err)
}

func TestTaskGraphOneLayerExternalPrerequisitesAndOrdinaryBranches(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	y := createTask(t, tasks, principal, project.ID, "External predecessor")
	x := createTask(t, tasks, principal, project.ID, "External context", y.ID)
	sibling := createTask(t, tasks, principal, project.ID, "External chain successor", x.ID)
	a := createTask(t, tasks, principal, project.ID, "Chain root")
	b := createTask(t, tasks, principal, project.ID, "Chain branch B", a.ID)
	b = updateTask(t, tasks, principal, b, UpdateTask{DependsOn: pointer([]string{a.ID, x.ID}), ExternalDependsOn: pointer([]string{x.ID})})
	c := createTask(t, tasks, principal, project.ID, "Chain branch C", a.ID)
	d := createTask(t, tasks, principal, project.ID, "Chain join", b.ID, c.ID)
	reverse := createTask(t, tasks, principal, project.ID, "External dependent", b.ID)
	reverse = updateTask(t, tasks, principal, reverse, UpdateTask{ExternalDependsOn: pointer([]string{b.ID})})
	isolated := createTask(t, tasks, principal, project.ID, "Isolated")
	for _, seed := range []core.Task{a, b, c, d} {
		graph, err := tasks.Graph(ctx, principal, strings.ToUpper(project.ID), strings.ToUpper(seed.ID))
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0, len(graph.Tasks))
		for _, task := range graph.Tasks {
			ids = append(ids, task.ID)
		}
		if !slices.Equal(ids, []string{x.ID, a.ID, b.ID, c.ID, d.ID}) || graph.Summary != (core.TaskGraphSummary{Total: 5, Todo: 5, Ready: 1, Blocked: 4}) {
			t.Fatalf("seed %s changed ordinary component or expanded external context: %#v", seed.ID, graph)
		}
		context := graph.Tasks[0]
		if !slices.Equal(context.DependsOn, []string{y.ID}) || !slices.Equal(context.BlockedBy, []string{y.ID}) || context.Ready || len(context.ExternalDependsOn) != 0 {
			t.Fatalf("external context dependencies were truncated: %#v", context)
		}
	}
	graph, err := tasks.Graph(ctx, principal, project.ID, x.ID)
	if err != nil || len(graph.Tasks) != 3 || graph.Tasks[0].ID != y.ID || graph.Tasks[1].ID != x.ID || graph.Tasks[2].ID != sibling.ID {
		t.Fatalf("external dependent entered another chain: %#v %v", graph, err)
	}
	graph, err = tasks.Graph(ctx, principal, project.ID, isolated.ID)
	if err != nil || len(graph.Tasks) != 1 || graph.Tasks[0].ID != isolated.ID || graph.Summary != (core.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}) {
		t.Fatalf("isolated task lost its graph: %#v %v", graph, err)
	}
}

func TestTaskGraphIgnoresUnrelatedProjectCapacityAndRefusesDeletedRoot(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	isolated := createTask(t, tasks, principal, project.ID, "Selected isolated task")
	seedGraph(t, database, project.ID, 1001, 5001)
	graph, err := tasks.Graph(ctx, principal, project.ID, isolated.ID)
	if err != nil || len(graph.Tasks) != 1 || graph.Tasks[0].ID != isolated.ID {
		t.Fatalf("unrelated project data refused scoped graph: %#v %v", graph, err)
	}
	_, err = tasks.Graph(ctx, principal, project.ID, "invalid")
	requireFault(t, err, "invalid_input")
	if err := tasks.Delete(ctx, principal, project.ID, isolated.ID, DeleteTask{Version: isolated.Version}); err != nil {
		t.Fatal(err)
	}
	graph, err = tasks.Graph(ctx, principal, project.ID, isolated.ID)
	fault := requireFault(t, err, "task_deleted")
	if !errors.Is(fault, core.ErrTaskDeleted) || !reflect.DeepEqual(graph, core.TaskGraph{}) {
		t.Fatalf("deleted root leaked graph: %#v %v", graph, err)
	}
}
