package postgres

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestExternalDependencyStoreReadsWritesAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project, foreign := queryProject(t, database, 1), queryProject(t, database, 2)
	done := queryTask(t, database, project.ID, 10, model.TaskDone)
	pending := queryTask(t, database, project.ID, 11, model.TaskTodo)
	target := queryTask(t, database, project.ID, 12, model.TaskTodo)
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3),($1,$2,$4)`, project.ID, target.ID, pending.ID, done.ID)
	ordinary := snapshotTask(t, database, project.ID, target.ID)
	if ordinary.ExternalDependsOn == nil || len(ordinary.ExternalDependsOn) != 0 || !slices.Equal(ordinary.DependsOn, []string{done.ID, pending.ID}) {
		t.Fatalf("ordinary edge projection: %#v", ordinary)
	}
	_, err := database.Pool.Exec(ctx, `UPDATE task_dependencies SET external=NULL WHERE task_id=$1`, target.ID)
	var nullConstraint *pgconn.PgError
	if !errors.As(err, &nullConstraint) || nullConstraint.Code != "23502" {
		t.Fatalf("external marker accepted NULL: %v", err)
	}
	foreignDone := queryTask(t, database, foreign.ID, 20, model.TaskDone)
	foreignTarget := queryTask(t, database, foreign.ID, 21, model.TaskTodo, foreignDone.ID)
	mustQueryExec(t, database, `UPDATE tasks SET allow_agents=true WHERE id=$1`, target.ID)
	mustQueryExec(t, database, `UPDATE task_dependencies SET external=true WHERE task_id=ANY($1::uuid[])`, []string{target.ID, foreignTarget.ID})
	target = snapshotTask(t, database, project.ID, target.ID)
	if !slices.Equal(target.ExternalDependsOn, []string{done.ID, pending.ID}) || !slices.Equal(target.BlockedBy, []string{pending.ID}) || target.Ready {
		t.Fatalf("external edges changed scheduling or ordering: %#v", target)
	}
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		created, err := tx.TaskDAO().CreateTask(ctx, queryID(13), TaskWrite{Title: "Mixed edge task", Status: model.TaskTodo, DependsOn: []string{pending.ID, done.ID}, ExternalDependsOn: []string{done.ID}})
		if err != nil || !slices.Equal(created.ExternalDependsOn, []string{done.ID}) || !slices.Equal(created.BlockedBy, []string{pending.ID}) {
			t.Fatalf("store did not persist mixed edge classification: %#v, %v", created, err)
		}
		read, err := tx.TaskDAO().TasksByID(ctx, []string{target.ID, foreignTarget.ID})
		if err != nil || len(read) != 1 || !reflect.DeepEqual(read[0], target) {
			t.Fatalf("transaction read lost classification or scope: %#v, %v", read, err)
		}
		reachable, err := tx.TaskDAO().Reachable(ctx, target.ID, pending.ID, DependencyReplacement{TaskID: target.ID, DependsOn: target.DependsOn})
		if err != nil || !reachable {
			t.Fatalf("external edge disappeared from reachability: %v, %v", reachable, err)
		}
		updated, err := tx.TaskDAO().UpdateTask(ctx, target.ID, TaskWrite{AllowAgents: target.AllowAgents, Title: "Preserved external edges", Status: target.Status, DependsOn: target.DependsOn, ExternalDependsOn: target.ExternalDependsOn})
		if err != nil || !updated.AllowAgents || !slices.Equal(updated.ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatalf("store replacement lost external classification: %#v, %v", updated, err)
		}
		target = updated
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.TaskDAO().Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
		if err != nil || len(page.Items) != 4 || !reflect.DeepEqual(page.Items[2], target) {
			t.Fatalf("scoped list lost classification: %#v, %v", page, err)
		}
		graph, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, target.ID, testGraphSelection(), 160)
		if err != nil || len(graph) != 3 || !slices.Equal(graph[2].ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatalf("scoped graph lost classification: %#v, %v", graph, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	err = writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, target.ID, TaskWrite{AllowAgents: target.AllowAgents, Title: "Rolled back", Status: target.Status, DependsOn: []string{done.ID, target.ID}, ExternalDependsOn: []string{done.ID}})
		return err
	})
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), target) {
		t.Fatalf("failed edge replacement lost metadata/classification rollback: %v", err)
	}
}
