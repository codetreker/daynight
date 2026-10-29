package store

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

func externalDependencyFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	for name, query := range map[string]string{
		"projects":     `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text FROM projects t`,
		"tasks":        `SELECT coalesce(jsonb_agg(to_jsonb(t)-'required_platform' ORDER BY id),'[]'::jsonb)::text FROM tasks t`,
		"attachments":  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,path),'[]'::jsonb)::text FROM task_attachments t`,
		"dependencies": `SELECT coalesce(jsonb_agg(to_jsonb(t)-'external' ORDER BY project_id,task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies t`,
	} {
		var value string
		if err := database.Pool.QueryRow(context.Background(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestExternalDependencyMigrationPreservesExistingFactsAndDefaults(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:11]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	for number, status := range map[int]core.TaskStatus{10: core.TaskDone, 11: core.TaskTodo, 12: core.TaskStatus("proposed")} {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,properties)
			VALUES ($1,$2,'Preserved title','Preserved description',$3,17,$4,$5,$4,$5,'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved"}]}')`,
			queryID(number), project.ID, status, stamp, stamp.Add(time.Hour))
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3),($1,$4,$3)`, project.ID, queryID(11), queryID(10), queryID(12))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES ($1,$2,'plan.md','text/markdown',123)`, project.ID, queryID(11))
	before := externalDependencyFacts(t, database)
	var ledger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY version)::text FROM schema_migrations t`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	if after := externalDependencyFacts(t, database); !reflect.DeepEqual(after, before) {
		t.Fatalf("external dependency migration changed existing facts: before=%v after=%v", before, after)
	}
	var preserved string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY version)::text FROM schema_migrations t WHERE version<=11`).Scan(&preserved); err != nil || preserved != ledger {
		t.Fatalf("migration changed the existing ledger: %v", err)
	}
	for _, number := range []int{11, 12} {
		task := snapshotHistoricalTask(t, database, project.ID, queryID(number))
		if task.ExternalDependsOn == nil || len(task.ExternalDependsOn) != 0 || !slices.Equal(task.DependsOn, []string{queryID(10)}) {
			t.Fatalf("historical edge was not normal: %#v", task)
		}
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3)`, project.ID, queryID(12), queryID(11))
	var external bool
	if err := pool.QueryRow(ctx, `SELECT external FROM task_dependencies WHERE task_id=$1 AND depends_on_task_id=$2`, queryID(12), queryID(11)).Scan(&external); err != nil || external {
		t.Fatalf("new edge did not default to normal: %v, %v", external, err)
	}
	_, err := pool.Exec(ctx, `UPDATE task_dependencies SET external=NULL WHERE task_id=$1`, queryID(12))
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23502" {
		t.Fatalf("external marker accepted NULL: %v", err)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=12").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	var repeated time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=12").Scan(&repeated); err != nil || !repeated.Equal(applied) {
		t.Fatalf("repeated migration changed ledger: %v, %v", repeated, err)
	}
}

func TestExternalDependencyStoreReadsWritesAndRollback(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project, foreign := queryProject(t, database, 1), queryProject(t, database, 2)
	done := queryTask(t, database, project.ID, 10, core.TaskDone)
	pending := queryTask(t, database, project.ID, 11, core.TaskTodo)
	target := queryTask(t, database, project.ID, 12, core.TaskTodo, pending.ID, done.ID)
	foreignDone := queryTask(t, database, foreign.ID, 20, core.TaskDone)
	foreignTarget := queryTask(t, database, foreign.ID, 21, core.TaskTodo, foreignDone.ID)
	mustQueryExec(t, database, `UPDATE tasks SET allow_agents=true WHERE id=$1`, target.ID)
	mustQueryExec(t, database, `UPDATE task_dependencies SET external=true WHERE task_id=ANY($1::uuid[])`, []string{target.ID, foreignTarget.ID})
	target = snapshotTask(t, database, project.ID, target.ID)
	if !slices.Equal(target.ExternalDependsOn, []string{done.ID, pending.ID}) || !slices.Equal(target.BlockedBy, []string{pending.ID}) || target.Ready {
		t.Fatalf("external edges changed scheduling or ordering: %#v", target)
	}
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		created, err := tx.CreateTask(ctx, queryID(13), TaskWrite{Title: "Mixed edge task", Status: core.TaskTodo, DependsOn: []string{pending.ID, done.ID}, ExternalDependsOn: []string{done.ID}})
		if err != nil || !slices.Equal(created.ExternalDependsOn, []string{done.ID}) || !slices.Equal(created.BlockedBy, []string{pending.ID}) {
			t.Fatalf("store did not persist mixed edge classification: %#v, %v", created, err)
		}
		read, err := tx.TasksByID(ctx, []string{target.ID, foreignTarget.ID})
		if err != nil || len(read) != 1 || !reflect.DeepEqual(read[0], target) {
			t.Fatalf("transaction read lost classification or scope: %#v, %v", read, err)
		}
		reachable, err := tx.Reachable(ctx, target.ID, pending.ID, DependencyReplacement{TaskID: target.ID, DependsOn: target.DependsOn})
		if err != nil || !reachable {
			t.Fatalf("external edge disappeared from reachability: %v, %v", reachable, err)
		}
		updated, err := tx.UpdateTask(ctx, target.ID, TaskWrite{AllowAgents: target.AllowAgents, Title: "Preserved external edges", Status: target.Status, DependsOn: target.DependsOn, ExternalDependsOn: target.ExternalDependsOn})
		if err != nil || !updated.AllowAgents || !slices.Equal(updated.ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatalf("store replacement lost external classification: %#v, %v", updated, err)
		}
		target = updated
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		page, err := snapshot.Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
		if err != nil || len(page.Items) != 4 || !reflect.DeepEqual(page.Items[2], target) {
			t.Fatalf("scoped list lost classification: %#v, %v", page, err)
		}
		graph, err := snapshot.TaskGraphTasks(ctx, project.ID, target.ID, 160)
		if err != nil || len(graph) != 3 || !slices.Equal(graph[2].ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatalf("scoped graph lost classification: %#v, %v", graph, err)
		}
		size, err := snapshot.TaskGraphSize(ctx, project.ID)
		if err != nil || size != (TaskGraphSize{NodeCount: 4, EdgeCount: 4}) {
			t.Fatalf("external edges changed graph budget: %#v, %v", size, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		_, err := tx.UpdateTask(ctx, target.ID, TaskWrite{AllowAgents: target.AllowAgents, Title: "Rolled back", Status: target.Status, DependsOn: []string{done.ID, target.ID}, ExternalDependsOn: []string{done.ID}})
		return err
	})
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), target) {
		t.Fatalf("failed edge replacement lost metadata/classification rollback: %v", err)
	}
}

func TestExternalDependencyStoreReadFailuresPreserveCauses(t *testing.T) {
	for _, canceled := range []bool{true, false} {
		t.Run(map[bool]string{true: "cancellation", false: "missing marker column"}[canceled], func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			predecessor := queryTask(t, database, project.ID, 10, core.TaskDone)
			target := queryTask(t, database, project.ID, 11, core.TaskTodo, predecessor.ID)
			if !canceled {
				mustQueryExec(t, database, "ALTER TABLE task_dependencies DROP COLUMN external")
			}
			err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if canceled {
					cancel()
				}
				_, err := snapshot.Task(ctx, project.ID, target.ID)
				return err
			})
			if canceled {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("classification read lost cancellation: %v", err)
				}
			} else {
				var cause *pgconn.PgError
				if !errors.As(err, &cause) || cause.Code != "42703" {
					t.Fatalf("classification read lost native cause: %v", err)
				}
			}
		})
	}
}
