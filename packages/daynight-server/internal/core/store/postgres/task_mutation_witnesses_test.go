package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func taskMutationValues(task model.Task) TaskWrite {
	return TaskWrite{
		AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform,
		AllowAgents: task.AllowAgents, Title: task.Title, Description: task.Description,
		Properties: task.Properties, Status: task.Status,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn,
	}
}

func taskMutationPR(t *testing.T, url, title string) model.TaskProperties {
	t.Helper()
	data, err := json.Marshal([]struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}{{URL: url, Title: title}})
	if err != nil {
		t.Fatal(err)
	}
	return model.TaskProperties{"pullRequests": data}
}

func taskMutationProjectFacts(t *testing.T, database *Store, projectID string) string {
	t.Helper()
	var facts string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
		'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t WHERE project_id=$1),
		'properties',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY task_id,name),'[]'::jsonb) FROM task_properties p WHERE task_id IN(SELECT id FROM tasks WHERE project_id=$1)),
		'edges',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id),'[]'::jsonb) FROM task_dependencies d WHERE project_id=$1),
		'epoch',(SELECT task_cache_epoch FROM projects WHERE id=$1))::text`, projectID).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestTaskPartialWriteFailureRollsBackMetadataAndAllEdges(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	a := queryTask(t, database, project.ID, 11, model.TaskTodo)
	b := queryTask(t, database, project.ID, 12, model.TaskTodo)
	old := queryTask(t, database, project.ID, 13, model.TaskTodo)
	target := queryTask(t, database, project.ID, 14, model.TaskTodo, old.ID)
	dependencies := []string{a.ID, b.ID}
	slices.Sort(dependencies)
	values := taskMutationValues(target)
	values.Title, values.Description, values.DependsOn = "Changed", "Changed", dependencies
	values.Properties = taskMutationPR(t, "changed", "Changed")
	mustQueryExec(t, database, fmt.Sprintf(`CREATE FUNCTION reject_second_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		IF NEW.depends_on_task_id='%s'::uuid THEN
			IF NEW.task_id='%s'::uuid AND (
				NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id AND title='Changed' AND description='Changed' AND version=%d)
				OR NOT EXISTS(SELECT 1 FROM task_properties WHERE task_id=NEW.task_id AND name='pullRequests' AND value='[{"url":"changed","title":"Changed"}]')
				OR NOT EXISTS(SELECT 1 FROM task_dependencies WHERE project_id=NEW.project_id AND task_id=NEW.task_id AND depends_on_task_id='%s'::uuid)
			) THEN RAISE EXCEPTION USING ERRCODE='P1002',MESSAGE='partial write barrier not reached'; END IF;
			RAISE EXCEPTION USING ERRCODE='P1001',MESSAGE='private edge diagnostic';
		END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_second_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_second_edge()`, dependencies[1], target.ID, target.Version+1, dependencies[0]))
	before := taskMutationProjectFacts(t, database, project.ID)
	for _, create := range []bool{false, true} {
		completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
			if create {
				_, err := scope.TaskDAO().CreateTask(ctx, queryID(15), values)
				return err
			}
			_, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values)
			return err
		})
		var cause *pgconn.PgError
		if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1001" || strings.Contains(err.Error(), "private edge") {
			t.Fatalf("partial write lost rollback or safe driver cause: completion=%#v err=%v", completion, err)
		}
		if after := taskMutationProjectFacts(t, database, project.ID); before != after {
			t.Fatalf("partial update/create persisted: %s -> %s", before, after)
		}
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_second_edge ON task_dependencies; DROP FUNCTION reject_second_edge()`)
	var updated model.Task
	if err := writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
		var err error
		updated, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if updated.Version != target.Version+1 || updated.Title != values.Title || updated.Description != values.Description || !slices.Equal(updated.DependsOn, dependencies) || !reflect.DeepEqual(updated.Properties, values.Properties) || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), updated) {
		t.Fatalf("reused transaction did not persist the complete replacement: %#v", updated)
	}
}

func TestTaskStatusPartialWriteFailureRollsBackTimingAndMaterials(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	predecessor := queryTask(t, database, project.ID, 11, model.TaskDone)
	target := queryTask(t, database, project.ID, 12, model.TaskTodo, predecessor.ID)
	values := taskMutationValues(target)
	values.Title, values.Description, values.AllowAgents = "Original", "Preserved Markdown", true
	values.ExternalDependsOn = []string{predecessor.ID}
	values.Properties = taskMutationPR(t, "https://github.com/owner/repo/pull/1", "Existing evidence")
	if err := writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
		var err error
		target, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, fmt.Sprintf(`CREATE FUNCTION reject_status_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND status='in_progress' AND started_at=updated_at AND completed_at IS NULL AND version=%d)
		THEN RAISE EXCEPTION USING ERRCODE='P1002',MESSAGE='status write barrier not reached'; END IF;
		RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='private status edge diagnostic'; END $$;
		CREATE TRIGGER reject_status_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_status_edge()`, target.Version+1))
	before := taskMutationProjectFacts(t, database, project.ID)
	values.Status = model.TaskInProgress
	completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values)
		return err
	})
	var cause *pgconn.PgError
	if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1003" || strings.Contains(err.Error(), "private status") || before != taskMutationProjectFacts(t, database, project.ID) {
		t.Fatalf("later edge failure committed status, timing, material or classification: %#v %v", completion, err)
	}
}

type taskMutationTrace struct {
	match  func(string) bool
	after  bool
	cancel context.CancelFunc
}

type taskMutationTraceKey struct{}

func (trace taskMutationTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, query pgx.TraceQueryStartData) context.Context {
	matched := trace.match(query.SQL)
	if matched && !trace.after {
		trace.cancel()
	}
	return context.WithValue(ctx, taskMutationTraceKey{}, matched)
}

func (trace taskMutationTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if trace.after && ctx.Value(taskMutationTraceKey{}) == true {
		trace.cancel()
	}
}

func taskMutationTracedStore(t *testing.T, database *Store, trace taskMutationTrace) *Store {
	t.Helper()
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{Pool: pool}
}

func TestTaskQueryCancellationPreservesCauseAndCompleteState(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	predecessor := queryTask(t, database, project.ID, 11, model.TaskDone)
	target := queryTask(t, database, project.ID, 12, model.TaskInProgress, predecessor.ID)
	before := taskMutationProjectFacts(t, database, project.ID)
	queries := []struct {
		name, fragment string
		operation      func(context.Context, TaskWriteDAO) error
	}{
		{"task", "FROM tasks t", func(ctx context.Context, dao TaskWriteDAO) error { _, err := dao.Task(ctx, target.ID); return err }},
		{"prerequisites", "t.id = ANY($2::uuid[])", func(ctx context.Context, dao TaskWriteDAO) error {
			_, err := dao.TasksByID(ctx, []string{predecessor.ID})
			return err
		}},
		{"reachability", "WITH RECURSIVE edges", func(ctx context.Context, dao TaskWriteDAO) error {
			_, err := dao.Reachable(ctx, target.ID, predecessor.ID, DependencyReplacement{TaskID: target.ID, DependsOn: target.DependsOn})
			return err
		}},
		{"active dependents", "SELECT t.id::text FROM task_dependencies d", func(ctx context.Context, dao TaskWriteDAO) error {
			_, err := dao.ActiveDependentIDs(ctx, predecessor.ID)
			return err
		}},
		{"status write", "UPDATE tasks SET", func(ctx context.Context, dao TaskWriteDAO) error {
			values := taskMutationValues(target)
			values.Status = model.TaskDone
			_, err := dao.UpdateTask(ctx, target.ID, values)
			return err
		}},
	}
	for _, query := range queries {
		for _, after := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s_after=%t", query.name, after), func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				traced := taskMutationTracedStore(t, database, taskMutationTrace{match: func(sql string) bool { return strings.Contains(sql, query.fragment) }, after: after, cancel: cancel})
				completion, err := traced.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error { return query.operation(ctx, scope.TaskDAO()) })
				if !errors.Is(err, context.Canceled) || completion.Outcome == TransactionCommitted {
					t.Fatalf("canceled query hid cause or committed: %#v %v", completion, err)
				}
				if got := taskMutationProjectFacts(t, database, project.ID); got != before {
					t.Fatalf("canceled query changed material, edges or timing: %s -> %s", before, got)
				}
			})
		}
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestTaskDeletionAndDependencyRemovalFailuresRollBackAllFacts(t *testing.T) {
	for _, failure := range []string{"epoch", "source-overflow"} {
		t.Run(failure, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
			source := queryTask(t, database, project.ID, 12, model.TaskTodo, target.ID)
			if failure == "epoch" {
				mustQueryExec(t, database, `CREATE FUNCTION reject_dependency_delete_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1004',MESSAGE='epoch rotation failed'; END $$;
				CREATE TRIGGER reject_dependency_delete_epoch BEFORE UPDATE OF task_cache_epoch ON projects FOR EACH ROW EXECUTE FUNCTION reject_dependency_delete_epoch()`)
			} else {
				mustQueryExec(t, database, "UPDATE tasks SET version=9223372036854775807 WHERE id=$1", source.ID)
			}
			before := taskMutationProjectFacts(t, database, project.ID)
			completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
				if _, err := scope.TaskDAO().DeleteTask(ctx, target.ID, true); err != nil {
					return err
				}
				return scope.ProjectDAO().InvalidateTaskCache(ctx)
			})
			var cause *pgconn.PgError
			if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || before != taskMutationProjectFacts(t, database, project.ID) {
				t.Fatalf("failed deletion committed tombstone, source version, edges or epoch: %#v %v", completion, err)
			}
		})
	}
}

func TestTaskDependencyWritesRetainExactCountsAndClassification(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	ids := make([]string, 16)
	for i := range ids {
		ids[i] = queryTask(t, database, project.ID, i+11, model.TaskTodo).ID
	}
	var target model.Task
	values := TaskWrite{Title: "Target", Status: model.TaskTodo, DependsOn: slices.Clone(ids[:15]), ExternalDependsOn: slices.Clone(ids[:2])}
	if err := writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
		var err error
		target, err = scope.TaskDAO().CreateTask(ctx, queryID(30), values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var stored, external []string
	if err := database.Pool.QueryRow(ctx, `SELECT ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE task_id=$1 ORDER BY depends_on_task_id),ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE task_id=$1 AND external ORDER BY depends_on_task_id)`, target.ID).Scan(&stored, &external); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(stored, ids[:15]) || !slices.Equal(external, ids[:2]) || target.Ready {
		t.Fatalf("fifteen stored edges lost order/classification: %#v %#v %#v", stored, external, target)
	}
	before := taskMutationProjectFacts(t, database, project.ID)
	rejected := errors.New("reject candidate before dependency SQL")
	completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		current, err := scope.TaskDAO().Task(ctx, target.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(current, target) {
			t.Errorf("candidate read changed complete task: %#v", current)
		}
		return rejected
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, rejected) || before != taskMutationProjectFacts(t, database, project.ID) {
		t.Fatalf("refused read-only scope changed stored edges: %#v %v", completion, err)
	}
}

func TestTaskReadOnlyScopePreservesExactLargeVersionAndHistory(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 11, model.TaskDone)
	mustQueryExec(t, database, "UPDATE tasks SET version=9007199254740993 WHERE id=$1", target.ID)
	before := taskMutationProjectFacts(t, database, project.ID)
	results := make(chan error, 2)
	if err := writeProjectForTest(database, ctx, project.ID, func(ProjectWriteScope) error {
		for range 2 {
			go func() {
				results <- writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
					current, err := scope.TaskDAO().Task(ctx, target.ID)
					if err != nil {
						return err
					}
					if current.Version != 9007199254740993 {
						return fmt.Errorf("read truncated exact task version: %d", current.Version)
					}
					return nil
				})
			}()
		}
		taskMutationWaitForWriters(t, ctx, database, 2)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := receiveQueryResult(t, ctx, results); err != nil {
			t.Fatal(err)
		}
	}
	if before != taskMutationProjectFacts(t, database, project.ID) {
		t.Fatal("read-only write scope changed history or timestamp")
	}
}

func taskMutationWaitForWriters(t *testing.T, ctx context.Context, database *Store, count int) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("competing task writers never reached their project lock")
		case <-ticker.C:
		}
	}
}

func TestConcurrentSameVersionTaskWritesReadFreshAfterProjectLock(t *testing.T) {
	for _, kind := range []string{"metadata", "status", "permission", "platform", "assignment"} {
		t.Run(kind, func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			conflict := errors.New("writer observed preceding version")
			results := make(chan error, 2)
			if err := writeProjectForTest(database, ctx, project.ID, func(ProjectWriteScope) error {
				for _, title := range []string{"First", "Second"} {
					go func() {
						results <- writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
							current, err := scope.TaskDAO().Task(ctx, target.ID)
							if err != nil {
								return err
							}
							if current.Version != target.Version {
								return conflict
							}
							values := taskMutationValues(current)
							values.Title = title
							switch kind {
							case "metadata":
								values.Description = title
								values.Properties = taskMutationPR(t, strings.ToLower(title), title)
							case "status":
								values.Status = model.TaskInProgress
							case "permission":
								values.AllowAgents = true
							case "platform":
								platform := model.TaskPlatform("linux")
								values.RequiredPlatform = &platform
							case "assignment":
								var userID string
								if err := database.Pool.QueryRow(ctx, "SELECT user_id::text FROM team_members WHERE team_id=(SELECT team_id FROM project_ownership WHERE project_id=$1) LIMIT 1", project.ID).Scan(&userID); err != nil {
									return err
								}
								values.AssignedTo = &userID
							}
							_, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
							return err
						})
					}()
				}
				taskMutationWaitForWriters(t, ctx, database, 2)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			succeeded, refused := 0, 0
			for range 2 {
				err := receiveQueryResult(t, ctx, results)
				if err == nil {
					succeeded++
				} else if errors.Is(err, conflict) {
					refused++
				} else {
					t.Fatal(err)
				}
			}
			after := snapshotTask(t, database, project.ID, target.ID)
			if succeeded != 1 || refused != 1 || after.Version != target.Version+1 || (after.Title != "First" && after.Title != "Second") {
				t.Fatalf("serialized writer lost fresh version or committed twice: %#v success=%d refused=%d", after, succeeded, refused)
			}
			if kind == "metadata" {
				want := taskMutationPR(t, strings.ToLower(after.Title), after.Title)
				if after.Description != after.Title || !reflect.DeepEqual(after.Properties, want) {
					t.Fatal("competing writes mixed material fields")
				}
			}
		})
	}
}

func TestProjectWriteScopeRechecksMemberRemovalAfterLockWait(t *testing.T) {
	for _, removeActor := range []bool{false, true} {
		t.Run(fmt.Sprintf("actor=%t", removeActor), func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			actor := storeAssigneeUser(t, database, project.ID, 51, true)
			target := storeAssigneeUser(t, database, project.ID, 52, true)
			before := queryTask(t, database, project.ID, 11, model.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			results := make(chan error, 1)
			if err := writeProjectForTest(database, ctx, project.ID, func(holder ProjectWriteScope) error {
				go func() {
					results <- writeProjectForTest(database, ctx, project.ID, func(waiter ProjectWriteScope) error {
						if _, err := waiter.ProjectDAO().ProjectAccess(ctx, model.Principal{UserID: actor}); err != nil {
							return err
						}
						_, err := waiter.ProjectDAO().ProjectAccess(ctx, model.Principal{UserID: target})
						return err
					})
				}()
				taskMutationWaitForWriters(t, ctx, database, 1)
				removed := target
				if removeActor {
					removed = actor
				}
				return holder.ProjectDAO().RemoveMember(ctx, removed)
			}); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, results); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("project writer reused a removed actor/target grant: %v", err)
			}
			if after := snapshotTask(t, database, project.ID, before.ID); !reflect.DeepEqual(after, before) {
				t.Fatalf("failed post-lock authorization changed the task: %#v", after)
			}
		})
	}
}

func TestTaskAssignmentTargetQueryFailureKeepsSafeDriverCause(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := storeAssigneeUser(t, database, project.ID, 51, true)
	before := queryTask(t, database, project.ID, 11, model.TaskTodo)
	ctx := context.Background()
	mustQueryExec(t, database, fmt.Sprintf(`CREATE FUNCTION refuse_assignment_target() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1030',MESSAGE='private assignment target'; END $$;
		ALTER TABLE project_grants RENAME TO assignment_member_source;
		CREATE VIEW project_grants AS SELECT project_id,user_id,CASE WHEN user_id='%s'::uuid THEN refuse_assignment_target() ELSE role END AS role,version,created_at,updated_at FROM assignment_member_source`, target))
	completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.ProjectDAO().ProjectAccess(ctx, model.Principal{UserID: target})
		return err
	})
	var cause *pgconn.PgError
	if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1030" || strings.Contains(err.Error(), "private assignment") {
		t.Fatalf("target query lost rollback or sanitized driver cause: %#v %v", completion, err)
	}
	mustQueryExec(t, database, `DROP VIEW project_grants; ALTER TABLE assignment_member_source RENAME TO project_grants; DROP FUNCTION refuse_assignment_target()`)
	if after := snapshotTask(t, database, project.ID, before.ID); !reflect.DeepEqual(after, before) {
		t.Fatalf("failed target query changed the task: %#v", after)
	}
}

func TestTaskReadAndWriteDatabaseFailures(t *testing.T) {
	for _, table := range []string{"tasks", "projects"} {
		t.Run(table, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
			mustQueryExec(t, database, "DROP TABLE "+table)
			operations := []func() error{
				func() error {
					return database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
						if _, err := scope.ProjectDAO().Project(ctx, project.ID); err != nil {
							return err
						}
						_, err := scope.TaskDAO().Task(ctx, project.ID, target.ID)
						return err
					})
				},
				func() error {
					return database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
						if _, err := scope.ProjectDAO().Project(ctx, project.ID); err != nil {
							return err
						}
						_, err := scope.TaskDAO().Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
						return err
					})
				},
				func() error {
					return writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
						_, err := scope.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "New", Status: model.TaskTodo})
						return err
					})
				},
				func() error {
					return writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
						values := taskMutationValues(target)
						values.Title = "Changed"
						_, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values)
						return err
					})
				},
			}
			for _, operation := range operations {
				err := operation()
				var cause *pgconn.PgError
				if !errors.As(err, &cause) || cause.Code != "42P01" {
					t.Fatalf("missing Task/Project relation lost its driver cause: %v", err)
				}
			}
		})
	}
	database := isolatedStore(t)
	database.Close()
	if err := database.ReadSnapshot(context.Background(), func(SnapshotScope) error { t.Error("closed pool entered snapshot callback"); return nil }); err == nil {
		t.Fatal("closed snapshot pool hid failure")
	}
}

func TestTaskDependencyDecisionQueriesReadPostLockCommittedFacts(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(fmt.Sprintf("external=%t", external), func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			predecessor := queryTask(t, database, project.ID, 11, model.TaskDone)
			successor := queryTask(t, database, project.ID, 12, model.TaskTodo)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			results := make(chan error, 1)
			if err := writeProjectForTest(database, ctx, project.ID, func(holder ProjectWriteScope) error {
				go func() {
					results <- writeProjectForTest(database, ctx, project.ID, func(waiter ProjectWriteScope) error {
						current, err := waiter.TaskDAO().Task(ctx, successor.ID)
						if err != nil {
							return err
						}
						if current.Status != model.TaskInProgress || current.Version != successor.Version+1 || !slices.Equal(current.DependsOn, []string{predecessor.ID}) {
							return errors.New("post-lock target read lost the preceding dependency/status write")
						}
						prerequisites, err := waiter.TaskDAO().TasksByID(ctx, current.DependsOn)
						if err != nil {
							return err
						}
						if len(prerequisites) != 1 || prerequisites[0].Status != model.TaskDone {
							return errors.New("post-lock prerequisite query lost the current state")
						}
						active, err := waiter.TaskDAO().ActiveDependentIDs(ctx, predecessor.ID)
						if err != nil {
							return err
						}
						if !slices.Equal(active, []string{successor.ID}) {
							return errors.New("post-lock active-dependent lookup missed a committed source")
						}
						reachable, err := waiter.TaskDAO().Reachable(ctx, successor.ID, predecessor.ID, DependencyReplacement{TaskID: predecessor.ID})
						if err != nil {
							return err
						}
						if !reachable {
							return errors.New("post-lock reachability ignored a committed reverse edge")
						}
						return nil
					})
				}()
				taskMutationWaitForWriters(t, ctx, database, 1)
				values := taskMutationValues(successor)
				values.Status, values.DependsOn = model.TaskInProgress, []string{predecessor.ID}
				if external {
					values.ExternalDependsOn = []string{predecessor.ID}
				}
				_, err := holder.TaskDAO().UpdateTask(ctx, successor.ID, values)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, results); err != nil {
				t.Fatal(err)
			}
			if after := snapshotTask(t, database, project.ID, predecessor.ID); !reflect.DeepEqual(after, predecessor) {
				t.Fatalf("decision reads mutated their prerequisite: %#v", after)
			}
		})
	}
}

func TestTaskDeletionPreservesCompletedWorkerHistory(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	owner := storeAssigneeUser(t, database, project.ID, 51, true)
	claim := workerWitnessClaim(11, owner, queryID(52), model.WorkerCompleted)
	target := workerWitnessTask(t, database, project.ID, 11, claim, true, nil)
	var before, after string
	readHistory := func() string {
		t.Helper()
		var history string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t)-ARRAY['updated_at','version','deleted_at'],
			'properties',(SELECT jsonb_object_agg(name,value) FROM task_properties WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, target.ID).Scan(&history); err != nil {
			t.Fatal(err)
		}
		return history
	}
	before = readHistory()
	var tombstone model.TaskTombstone
	if err := writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
		var err error
		tombstone, err = scope.TaskDAO().DeleteTask(ctx, target.ID, false)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	after = readHistory()
	if before != after || tombstone.Version != target.Version+1 || tombstone.DeletedAt.Before(target.UpdatedAt) {
		t.Fatalf("soft deletion lost completed worker/material history: %s -> %s, %#v", before, after, tombstone)
	}
}

func TestTaskDeletionSerializesWithIncomingSourceWrites(t *testing.T) {
	for _, scenario := range []struct {
		sourceKind    string
		removeDepends bool
	}{{"existing source", true}, {"new source", true}, {"new source", false}} {
		t.Run(fmt.Sprintf("%s_remove=%t", scenario.sourceKind, scenario.removeDepends), func(t *testing.T) {
			database := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			project := queryProject(t, database, 1)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
			var source model.Task
			if scenario.sourceKind == "existing source" {
				source = queryTask(t, database, project.ID, 12, model.TaskTodo, target.ID)
			}
			refused := errors.New("preceding source/deletion changed the visible facts")
			results := make(chan error, 2)
			if err := writeProjectForTest(database, ctx, project.ID, func(ProjectWriteScope) error {
				go func() {
					results <- writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
						if !scenario.removeDepends {
							incoming, err := scope.TaskDAO().DependentIDs(ctx, target.ID)
							if err != nil {
								return err
							}
							if len(incoming) > 0 {
								return refused
							}
						}
						_, err := scope.TaskDAO().DeleteTask(ctx, target.ID, scenario.removeDepends)
						return err
					})
				}()
				go func() {
					results <- writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
						if scenario.sourceKind == "existing source" {
							current, err := scope.TaskDAO().Task(ctx, source.ID)
							if err != nil {
								return err
							}
							if current.Version != source.Version {
								return refused
							}
							values := taskMutationValues(current)
							values.Title = "Changed"
							_, err = scope.TaskDAO().UpdateTask(ctx, current.ID, values)
							return err
						}
						prerequisites, err := scope.TaskDAO().TasksByID(ctx, []string{target.ID})
						if err != nil {
							return err
						}
						if len(prerequisites) == 0 {
							return refused
						}
						_, err = scope.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "New source", Status: model.TaskTodo, DependsOn: []string{target.ID}})
						return err
					})
				}()
				taskMutationWaitForWriters(t, ctx, database, 2)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			success := 0
			for range 2 {
				err := receiveQueryResult(t, ctx, results)
				if err == nil {
					success++
				} else if !errors.Is(err, refused) {
					t.Fatal(err)
				}
			}
			var marker bool
			var edges int
			if err := database.Pool.QueryRow(ctx, "SELECT deleted_at IS NOT NULL FROM tasks WHERE id=$1", target.ID).Scan(&marker); err != nil {
				t.Fatal(err)
			}
			if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=$2", project.ID, target.ID).Scan(&edges); err != nil {
				t.Fatal(err)
			}
			if !scenario.removeDepends {
				if success != 1 || (marker && edges != 0) || (!marker && edges != 1) {
					t.Fatalf("strict deletion and live incoming source both committed: tombstone=%t edges=%d success=%d", marker, edges, success)
				}
				return
			}
			if !marker || edges != 0 || success < 1 {
				t.Fatalf("incoming source escaped serialized removal: tombstone=%t edges=%d success=%d", marker, edges, success)
			}
			if scenario.sourceKind == "existing source" {
				current := snapshotTask(t, database, project.ID, source.ID)
				wantVersion := source.Version + int64(success)
				if len(current.DependsOn) != 0 || current.Version != wantVersion || (success == 2 && current.Title != "Changed") {
					t.Fatalf("serialized existing source lost CAS or removal version: %#v success=%d", current, success)
				}
			} else if success == 2 {
				current := snapshotTask(t, database, project.ID, queryID(12))
				if current.Version != 2 || len(current.DependsOn) != 0 || !current.Ready {
					t.Fatalf("new source committed before deletion retained a dangling edge: %#v", current)
				}
			}
		})
	}
}

func taskMutationRace(t *testing.T, database *Store, projectID string, operations ...func(context.Context, ProjectWriteScope) error) []error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	results := make(chan error, len(operations))
	if err := writeProjectForTest(database, ctx, projectID, func(ProjectWriteScope) error {
		for _, operation := range operations {
			go func() {
				results <- writeProjectForTest(database, ctx, projectID, func(scope ProjectWriteScope) error { return operation(ctx, scope) })
			}()
		}
		taskMutationWaitForWriters(t, ctx, database, len(operations))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	errors := make([]error, 0, len(operations))
	for range operations {
		errors = append(errors, receiveQueryResult(t, ctx, results))
	}
	return errors
}

func taskMutationOneWinner(t *testing.T, results []error, refusal error) {
	t.Helper()
	success, refused := 0, 0
	for _, err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, refusal) {
			refused++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || refused != 1 {
		t.Fatalf("competing decision reads admitted incompatible writes: success=%d refused=%d", success, refused)
	}
}

func TestTaskProjectSerializationSuppliesFreshReachabilityToCompetingWriters(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	a := queryTask(t, database, project.ID, 11, model.TaskTodo)
	b := queryTask(t, database, project.ID, 12, model.TaskTodo)
	refusal := errors.New("preceding edge is visible to the candidate query")
	operation := func(target, dependency model.Task) func(context.Context, ProjectWriteScope) error {
		return func(ctx context.Context, scope ProjectWriteScope) error {
			current, err := scope.TaskDAO().Task(ctx, target.ID)
			if err != nil {
				return err
			}
			candidate := []string{dependency.ID}
			reachable, err := scope.TaskDAO().Reachable(ctx, dependency.ID, target.ID, DependencyReplacement{TaskID: target.ID, DependsOn: candidate})
			if err != nil {
				return err
			}
			if reachable {
				return refusal
			}
			values := taskMutationValues(current)
			values.DependsOn = candidate
			_, err = scope.TaskDAO().UpdateTask(ctx, current.ID, values)
			return err
		}
	}
	taskMutationOneWinner(t, taskMutationRace(t, database, project.ID, operation(a, b), operation(b, a)), refusal)
	afterA, afterB := snapshotTask(t, database, project.ID, a.ID), snapshotTask(t, database, project.ID, b.ID)
	if len(afterA.DependsOn)+len(afterB.DependsOn) != 1 || afterA.Version+afterB.Version != a.Version+b.Version+1 {
		t.Fatalf("fresh reachability did not serialize reverse edge writes: %#v %#v", afterA, afterB)
	}
}

func TestTaskProjectSerializationKeepsPrerequisiteAndDependentQueriesConsistent(t *testing.T) {
	for _, edgeWrite := range []bool{false, true} {
		for _, external := range []bool{false, true} {
			for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
				t.Run(fmt.Sprintf("edge=%t_external=%t_status=%s", edgeWrite, external, status), func(t *testing.T) {
					database := isolatedStore(t)
					project := queryProject(t, database, 1)
					predecessor := queryTask(t, database, project.ID, 11, model.TaskDone)
					initialStatus := model.TaskTodo
					dependencies := []string{}
					if edgeWrite {
						initialStatus = status
					} else {
						dependencies = []string{predecessor.ID}
					}
					successor := queryTask(t, database, project.ID, 12, initialStatus, dependencies...)
					if external && !edgeWrite {
						mustQueryExec(t, database, "UPDATE task_dependencies SET external=true WHERE task_id=$1", successor.ID)
						successor = snapshotTask(t, database, project.ID, successor.ID)
					}
					refusal := errors.New("preceding scoped query exposes an incompatible committed fact")
					reopen := func(ctx context.Context, scope ProjectWriteScope) error {
						current, err := scope.TaskDAO().Task(ctx, predecessor.ID)
						if err != nil {
							return err
						}
						active, err := scope.TaskDAO().ActiveDependentIDs(ctx, predecessor.ID)
						if err != nil {
							return err
						}
						if len(active) > 0 {
							return refusal
						}
						values := taskMutationValues(current)
						values.Status = model.TaskTodo
						_, err = scope.TaskDAO().UpdateTask(ctx, current.ID, values)
						return err
					}
					advance := func(ctx context.Context, scope ProjectWriteScope) error {
						current, err := scope.TaskDAO().Task(ctx, successor.ID)
						if err != nil {
							return err
						}
						prerequisites, err := scope.TaskDAO().TasksByID(ctx, []string{predecessor.ID})
						if err != nil {
							return err
						}
						if len(prerequisites) != 1 || prerequisites[0].Status != model.TaskDone {
							return refusal
						}
						values := taskMutationValues(current)
						values.Status = status
						if edgeWrite {
							values.DependsOn = []string{predecessor.ID}
							if external {
								values.ExternalDependsOn = []string{predecessor.ID}
							}
						}
						_, err = scope.TaskDAO().UpdateTask(ctx, current.ID, values)
						return err
					}
					taskMutationOneWinner(t, taskMutationRace(t, database, project.ID, reopen, advance), refusal)
					afterPredecessor, afterSuccessor := snapshotTask(t, database, project.ID, predecessor.ID), snapshotTask(t, database, project.ID, successor.ID)
					if afterPredecessor.Version+afterSuccessor.Version != predecessor.Version+successor.Version+1 {
						t.Fatal("competing prerequisite/dependent queries changed both records")
					}
					if len(afterSuccessor.DependsOn) > 0 && afterSuccessor.Status != model.TaskTodo && afterPredecessor.Status != model.TaskDone {
						t.Fatalf("active stored dependent gained an unfinished prerequisite: %#v %#v", afterPredecessor, afterSuccessor)
					}
					if external && len(afterSuccessor.DependsOn) > 0 && !slices.Equal(afterSuccessor.ExternalDependsOn, []string{predecessor.ID}) {
						t.Fatal("competing dependency writes lost external classification")
					}
				})
			}
		}
	}
}
