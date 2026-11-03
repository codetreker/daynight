package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type taskQueryAction struct {
	match func(string) bool
	start func()
	end   func()
}

type taskQueryKey struct{}

func (action taskQueryAction) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	matched := action.match(data.SQL)
	if matched && action.start != nil {
		action.start()
	}
	return context.WithValue(ctx, taskQueryKey{}, matched)
}

func (action taskQueryAction) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(taskQueryKey{}) == true && action.end != nil {
		action.end()
	}
}

func tracedTasks(t *testing.T, databaseURL string, action taskQueryAction) *Tasks {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = action
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return NewTasks(&store.Store{Pool: pool})
}

func assertOperational(t *testing.T, err error) {
	t.Helper()
	var fault *Fault
	if err == nil || errors.As(err, &fault) {
		t.Fatalf("operational error was masked: %#v", err)
	}
}

func TestTaskReadAndWriteDatabaseFailures(t *testing.T) {
	for _, table := range []string{"tasks", "projects"} {
		t.Run(table, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			target := createTask(t, tasks, principal, project.ID, "Target")
			if _, err := database.Pool.Exec(context.Background(), "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			_, getErr := tasks.Get(context.Background(), principal, project.ID, target.ID)
			_, listErr := tasks.List(context.Background(), principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
			_, updateErr := tasks.Update(context.Background(), principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed")})
			_, createErr := tasks.Create(context.Background(), principal, project.ID, CreateTask{Title: "New"})
			failures := []error{getErr, listErr, updateErr, createErr}
			for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
				_, err := tasks.SetStatus(context.Background(), principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: status})
				failures = append(failures, err)
			}
			for _, err := range failures {
				assertOperational(t, err)
				var pgError *pgconn.PgError
				if !errors.As(err, &pgError) || pgError.Code != "42P01" {
					t.Fatalf("missing query cause: %v", err)
				}
			}
		})
	}
	tasks, database, project, _, principal := taskService(t)
	database.Close()
	_, err := tasks.List(context.Background(), principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
	assertOperational(t, err)
}

func TestTaskPolicyQueryCancellationPreservesCause(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	predecessor := createTask(t, tasks, principal, project.ID, "Predecessor")
	predecessor = startTask(t, tasks, principal, predecessor)
	predecessor = finishTask(t, tasks, principal, predecessor)
	target := createTask(t, tasks, principal, project.ID, "Target", predecessor.ID)
	target = startTask(t, tasks, principal, target)
	target = finishTask(t, tasks, principal, target)
	for _, fragment := range []string{"t.id = ANY($2::uuid[])", "WITH RECURSIVE edges"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, start: cancel})
			input := UpdateTask{Version: target.Version, Title: pointer("Rejected")}
			_, err := traced.Update(ctx, principal, project.ID, target.ID, input)
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("query cancellation cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
			assertTaskUnchanged(t, tasks, principal, predecessor)
		})
	}
}

func TestTaskStatusQueryCancellationPreservesCauseAndState(t *testing.T) {
	for _, action := range []struct{ from, to core.TaskStatus }{
		{core.TaskTodo, core.TaskInProgress}, {core.TaskInProgress, core.TaskDone}, {core.TaskDone, core.TaskTodo},
	} {
		for _, query := range []struct {
			fragment string
			after    bool
		}{{"FROM tasks t", false}, {"UPDATE tasks SET", false}, {"UPDATE tasks SET", true}} {
			t.Run(fmt.Sprintf("%s_to_%s %s after=%t", action.from, action.to, query.fragment, query.after), func(t *testing.T) {
				tasks, _, project, databaseURL, principal := taskService(t)
				predecessor := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Predecessor"))
				target := createTask(t, tasks, principal, project.ID, "Target", predecessor.ID)
				target = setStatusTask(t, tasks, principal, target, action.from)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				trace := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, query.fragment) }}
				if query.after {
					trace.end = cancel
				} else {
					trace.start = cancel
				}
				traced := tracedTasks(t, databaseURL, trace)
				_, err := traced.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: action.to})
				assertOperational(t, err)
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("status cancellation lost cause: %v", err)
				}
				assertTaskUnchanged(t, tasks, principal, target)
				assertTaskUnchanged(t, tasks, principal, predecessor)
			})
		}
	}
}

func TestTaskTransactionCompletionFailureDominatesDomainFault(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	missing := "00000000-0000-0000-0000-000000000000"
	for _, test := range []struct {
		name      string
		fragment  string
		operation func(context.Context, *Tasks) error
	}{
		{"missing task read", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.Get(ctx, principal, project.ID, missing)
			return err
		}},
		{"missing task update", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.Update(ctx, principal, project.ID, missing, UpdateTask{Version: 1, Title: pointer("Rejected")})
			return err
		}},
		{"stale version update", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: 2, Title: pointer("Rejected")})
			return err
		}},
		{"missing task status", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, missing, SetTaskStatus{Version: 1, Status: core.TaskInProgress})
			return err
		}},
		{"stale version status", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version + 1, Status: core.TaskTodo})
			return err
		}},
		{"same-state status", "FROM tasks t", func(ctx context.Context, s *Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: core.TaskTodo})
			return err
		}},
		{"invalid dependency create", "t.id = ANY($2::uuid[])", func(ctx context.Context, s *Tasks) error {
			_, err := s.Create(ctx, principal, project.ID, CreateTask{Title: "Rejected", DependsOn: []string{missing}})
			return err
		}},
		{"missing project read", "FROM project_members m", func(ctx context.Context, s *Tasks) error {
			_, err := s.Get(ctx, principal, missing, target.ID)
			return err
		}},
		{"missing project list", "FROM project_members m", func(ctx context.Context, s *Tasks) error {
			_, err := s.List(ctx, principal, missing, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }, end: cancel})
			err := test.operation(ctx, traced)
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("completion failure lost cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
		})
	}
}

func TestTaskPartialWriteFailureRollsBackMetadataAndAllEdges(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	old := createTask(t, tasks, principal, project.ID, "Old")
	target := createTask(t, tasks, principal, project.ID, "Target", old.ID)
	dependencies := []string{a.ID, b.ID}
	slices.Sort(dependencies)
	statement := fmt.Sprintf(`CREATE FUNCTION reject_second_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.depends_on_task_id = '%s'::uuid THEN RAISE EXCEPTION 'private edge diagnostic'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_second_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_second_edge()`, dependencies[1])
	if _, err := database.Pool.Exec(ctx, statement); err != nil {
		t.Fatal(err)
	}
	_, updateErr := tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed"), Description: pointer("Changed"), DependsOn: &dependencies})
	_, createErr := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Rejected create", DependsOn: dependencies})
	for _, err := range []error{updateErr, createErr} {
		assertOperational(t, err)
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || pgError.Code != "P0001" || strings.Contains(err.Error(), "private edge") {
			t.Fatalf("partial failure cause/redaction: %v", err)
		}
	}
	assertTaskUnchanged(t, tasks, principal, target)
	page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}})
	if err != nil || len(page.Items) != 4 {
		t.Fatalf("failed creation left rows: %#v, %v", page, err)
	}
}

func TestTaskSnapshotKeepsProjectAndDerivedTaskStateConsistent(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	predecessor := createTask(t, tasks, principal, project.ID, "Predecessor")
	target := createTask(t, tasks, principal, project.ID, "Target", predecessor.ID)
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") },
		end: func() {
			if err := database.WriteProject(context.Background(), project.ID, func(tx *store.ProjectTx) error {
				_, err := tx.UpdateTask(context.Background(), predecessor.ID, store.TaskWrite{Title: predecessor.Title, Status: core.TaskDone})
				return err
			}); err != nil {
				t.Fatal(err)
			}
		},
	})
	read, err := traced.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || read.Ready || !slices.Equal(read.BlockedBy, []string{predecessor.ID}) {
		t.Fatalf("RR task read mixed snapshots: %#v, %v", read, err)
	}
	fresh, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || !fresh.Ready || len(fresh.BlockedBy) != 0 || fresh.Version != target.Version || !fresh.UpdatedAt.Equal(target.UpdatedAt) {
		t.Fatalf("fresh read/metadata: %#v, %v", fresh, err)
	}
}

func TestTaskReopenDependentQueryCancellationPreservesCause(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	target := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Completed prerequisite"))
	dependent := startTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Active dependent", target.ID))
	for _, after := range []bool{false, true} {
		t.Run(fmt.Sprintf("after=%t", after), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			trace := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "SELECT t.id::text FROM task_dependencies d") }}
			if after {
				trace.end = cancel
			} else {
				trace.start = cancel
			}
			traced := tracedTasks(t, databaseURL, trace)
			_, err := traced.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: core.TaskTodo})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("dependent query cancellation lost cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
			assertTaskUnchanged(t, tasks, principal, dependent)
		})
	}
}

func TestTaskStatusPartialWriteFailureRollsBackTimingAndMaterials(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Completed prerequisite"))
	target, err := tasks.Create(ctx, principal, project.ID, CreateTask{
		Title: "Original", Description: "Preserved Markdown", DependsOn: []string{prerequisite.ID}, ExternalDependsOn: []string{prerequisite.ID},
		Properties: propertyPatch([]core.PullRequestProperty{{URL: "https://github.com/owner/repo/pull/1", Title: "Existing evidence"}}...),
	})
	if err != nil {
		t.Fatal(err)
	}
	target = updateTask(t, tasks, principal, target, UpdateTask{AllowAgents: pointer(true)})
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_status_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'private status edge diagnostic'; END $$;
		CREATE TRIGGER reject_status_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_status_edge()`); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: core.TaskInProgress})
	assertOperational(t, err)
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "P0001" || strings.Contains(err.Error(), "private status edge") {
		t.Fatalf("status write failure cause/redaction: %v", err)
	}
	assertTaskUnchanged(t, tasks, principal, target)
	assertTaskUnchanged(t, tasks, principal, prerequisite)
}
