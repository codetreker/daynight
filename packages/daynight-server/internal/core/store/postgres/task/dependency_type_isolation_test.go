package task_test

import (
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

// Ordinary endpoints make edge type, rather than endpoint type, the isolation boundary.
func insertGoalEdge(t *testing.T, db *postgres.Store, project, from, to string, external bool) {
	t.Helper()
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external,dependency_type,goal_edge_id)
 VALUES($1,$2,$3,$4,'goal',gen_random_uuid())`, project, from, to, external)
}

func TestTaskReadsIgnoreGoalEdges(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	done := readerTask(t, db, project.ID, 10, model.TaskDone)
	pending := readerTask(t, db, project.ID, 11, model.TaskTodo)
	external := readerTask(t, db, project.ID, 12, model.TaskTodo)
	owner := readerTask(t, db, project.ID, 13, model.TaskTodo, done.ID)
	insertGoalEdge(t, db, project.ID, owner.ID, pending.ID, false)
	insertGoalEdge(t, db, project.ID, owner.ID, external.ID, true)
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE project_id=$1`, project.ID, stamp)

	if err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		dao := scope.TaskDAO()
		got, err := dao.Task(ctx, project.ID, owner.ID)
		if err != nil {
			return err
		}
		if !slices.Equal(got.DependsOn, []string{done.ID}) || len(got.ExternalDependsOn) != 0 || len(got.BlockedBy) != 0 || !got.Ready {
			t.Fatalf("task projection included Goal edges: %+v", got)
		}
		ready := true
		page, err := dao.Tasks(ctx, project.ID, store.TaskQuery{Page: store.Page{Limit: 100}, Ready: &ready})
		if err != nil {
			return err
		}
		found := false
		for _, item := range page.Items {
			if item.ID == owner.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("ready list omitted owner: %+v", page)
		}
		priority, err := dao.TaskPriorityList(ctx, project.ID, store.TaskPriorityQuery{Limit: 100, Ready: &ready})
		if err != nil {
			return err
		}
		found = false
		for _, item := range priority.Items {
			if item.Task.ID == owner.ID && item.BlockedByCount == 0 {
				found = true
			}
		}
		if !found {
			t.Fatalf("ready priority omitted owner: %+v", priority)
		}
		graph, err := dao.TaskGraphTasks(ctx, project.ID, owner.ID, readerGraphSelection(), 160)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(graph))
		for _, item := range graph {
			ids = append(ids, item.ID)
		}
		slices.Sort(ids)
		if !slices.Equal(ids, []string{done.ID, owner.ID}) {
			t.Fatalf("graph crossed Goal edges: %+v", graph)
		}
		states, err := dao.TaskSyncDependencyStates(ctx, project.ID, nil)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(states[owner.ID], model.TaskDependencyState{TaskVersion: owner.Version, BlockedBy: []string{}, Ready: true}) {
			t.Fatalf("sync state included Goal edges: %+v", states[owner.ID])
		}
		views, err := dao.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		found = false
		for _, item := range views {
			if item.ID == owner.ID {
				found = true
				if !slices.Equal(item.DependsOn, []string{done.ID}) || len(item.ExternalDependsOn) != 0 {
					t.Fatalf("sync task included Goal edges: %+v", item)
				}
			}
		}
		if !found {
			t.Fatalf("sync omitted owner: %+v", views)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	window := stamp.Add(time.Second)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE id=$1`, pending.ID, window)
	if err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		states, err := scope.TaskDAO().TaskSyncDependencyStates(ctx, project.ID, &window)
		if err != nil {
			return err
		}
		if _, ok := states[owner.ID]; ok {
			t.Fatalf("Goal-only change patched ordinary owner: %+v", states)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := writerSearch(t, db, func(search store.TaskSearchSnapshot) error {
		graph, err := search.ContextGraph(ctx, project.ID, []string{owner.ID})
		if err != nil {
			return err
		}
		if len(graph.Nodes) != 2 || len(graph.Edges) != 1 || graph.Edges[0] != (store.TaskSearchEdge{TaskID: owner.ID, DependsOnID: done.ID}) {
			t.Fatalf("search graph crossed Goal edges: %+v", graph)
		}
		ready := true
		page, err := search.Matches(ctx, project.ID, store.TaskSearchQuery{Expression: atom(tasksearch.TitleField, "task"), Ready: &ready, Limit: 100})
		if err != nil {
			return err
		}
		found := false
		for _, item := range page.Items {
			if item.ID == owner.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("ready search omitted owner: %+v", page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskWritesPreserveGoalEdges(t *testing.T) {
	db := writerStore(t)
	ctx := t.Context()
	project := writerProject(t, db, 1)
	done := writerTask(t, db, project.ID, 10, model.TaskDone)
	pending := writerTask(t, db, project.ID, 11, model.TaskTodo)
	replacement := writerTask(t, db, project.ID, 12, model.TaskDone)
	owner := writerTask(t, db, project.ID, 13, model.TaskTodo, done.ID)
	activeGoal := writerTask(t, db, project.ID, 14, model.TaskInProgress)
	activeTask := writerTask(t, db, project.ID, 15, model.TaskInProgress, owner.ID)
	insertGoalEdge(t, db, project.ID, owner.ID, pending.ID, false)
	insertGoalEdge(t, db, project.ID, activeGoal.ID, owner.ID, false)
	if err := writerWrite(t, db, project.ID, func(dao store.TaskWriteDAO) error {
		ids, err := dao.ActiveDependentIDs(ctx, owner.ID)
		if err != nil {
			return err
		}
		if !slices.Equal(ids, []string{activeTask.ID}) {
			t.Fatalf("active dependents included Goal edge: %v", ids)
		}
		ids, err = dao.DependentIDs(ctx, owner.ID)
		if err != nil {
			return err
		}
		if !slices.Equal(ids, []string{activeTask.ID}) {
			t.Fatalf("dependents included Goal edge: %v", ids)
		}
		reachable, err := dao.Reachable(ctx, owner.ID, pending.ID, store.DependencyReplacement{TaskID: readerID(99), DependsOn: []string{}})
		if err != nil {
			return err
		}
		if reachable {
			t.Fatal("ordinary reachability crossed Goal edge")
		}
		values := readerMutationValues(owner)
		values.DependsOn = []string{replacement.ID}
		_, err = dao.UpdateTask(ctx, owner.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var taskEdges, goalEdges int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE dependency_type='task' AND depends_on_task_id=$2 AND goal_edge_id IS NULL),
 count(*) FILTER(WHERE dependency_type='goal' AND depends_on_task_id=$3 AND goal_edge_id IS NOT NULL)
 FROM task_dependencies WHERE project_id=$1 AND task_id=$4`, project.ID, replacement.ID, pending.ID, owner.ID).Scan(&taskEdges, &goalEdges); err != nil || taskEdges != 1 || goalEdges != 1 {
		t.Fatalf("replacement did not preserve Goal edge and create task edge: task=%d goal=%d err=%v", taskEdges, goalEdges, err)
	}

	if err := writerWrite(t, db, project.ID, func(dao store.TaskWriteDAO) error {
		_, err := dao.DeleteTask(ctx, owner.ID, true)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE dependency_type='task'), count(*) FILTER(WHERE dependency_type='goal')
 FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=$2`, project.ID, owner.ID).Scan(&taskEdges, &goalEdges); err != nil || taskEdges != 0 || goalEdges != 1 {
		t.Fatalf("delete did not preserve incoming Goal edge: task=%d goal=%d err=%v", taskEdges, goalEdges, err)
	}
	goalAfter := readerSnapshotTask(t, db, project.ID, activeGoal.ID)
	taskAfter := readerSnapshotTask(t, db, project.ID, activeTask.ID)
	if goalAfter.Version != activeGoal.Version || taskAfter.Version != activeTask.Version+1 {
		t.Fatalf("delete changed wrong dependent versions: goal=%d task=%d", goalAfter.Version, taskAfter.Version)
	}
}

func TestTaskWorkGroupsIgnoreGoalEdges(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	other := readerAssigneeUser(t, db, project.ID, 3, true)
	first := readerTask(t, db, project.ID, 10, model.TaskInProgress)
	second := readerTask(t, db, project.ID, 11, model.TaskInProgress)
	readerExec(t, db, `UPDATE tasks SET assigned_to=$1,started_at=COALESCE(started_at,created_at) WHERE id=$2`, actor, first.ID)
	readerExec(t, db, `UPDATE tasks SET assigned_to=$1,started_at=COALESCE(started_at,created_at) WHERE id=$2`, other, second.ID)
	insertGoalEdge(t, db, project.ID, first.ID, second.ID, false)
	if err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		dao := scope.TaskDAO()
		groups, err := dao.TaskWorkGroups(ctx, project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 10})
		if err != nil {
			return err
		}
		if len(groups.Items) != 1 || groups.Items[0].ID != first.ID || groups.Items[0].MemberCount != 1 || groups.Items[0].RootCount != 1 {
			t.Fatalf("work groups crossed Goal edge: %+v", groups)
		}
		targets, err := dao.TaskWorkTargets(ctx, project.ID, groups.Targets)
		if err != nil {
			return err
		}
		if len(targets.Items) != 1 || targets.Items[0].Task.ID != first.ID {
			t.Fatalf("work targets crossed Goal edge: %+v", targets)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
