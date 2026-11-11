package task_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestTypedQueriesFilterBeforePaginationAndHideDeletedParents(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	goal, deletedGoal, hidden, first, second, independent := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,parent_id,title,created_at,deleted_at) VALUES
		($1,$7,'goal',NULL,'needle goal',now()-interval '6 seconds',NULL),
		($2,$7,'goal',NULL,'needle deleted',now()-interval '5 seconds',now()),
		($3,$7,'task',$2,'needle hidden',now()-interval '4 seconds',NULL),
		($4,$7,'task',$1,'needle first',now()-interval '3 seconds',NULL),
		($5,$7,'task',$1,'needle second',now()-interval '2 seconds',NULL),
		($6,$7,'task',NULL,'needle independent',now()-interval '1 second',NULL)`, goal, deletedGoal, hidden, first, second, independent, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false)`, f.project, first, hidden)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	if _, err := reader.Task(ctx, f.project, hidden); !errors.Is(err, model.ErrTaskDeleted) {
		t.Fatalf("hidden child direct read: %v", err)
	}
	if _, err := reader.Task(ctx, uuid.NewString(), hidden); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign project direct read: %v", err)
	}
	presence, err := reader.TaskPresence(ctx, f.project, hidden)
	mustOK(t, err)
	if !presence.Found || presence.DeletedAt == nil {
		t.Fatalf("hidden child presence: %+v", presence)
	}
	page, err := reader.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 1}})
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != first || !page.HasMore {
		t.Fatalf("default page: %+v", page)
	}
	page, err = reader.Tasks(ctx, f.project, store.TaskQuery{Type: model.TaskTypeGoal, Page: store.Page{Limit: 1}})
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != goal || page.HasMore {
		t.Fatalf("goal page: %+v", page)
	}
	page, err = reader.Tasks(ctx, f.project, store.TaskQuery{Parent: &goal, Page: store.Page{Limit: 1}})
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != first || !page.HasMore {
		t.Fatalf("parent page: %+v", page)
	}
	none := "none"
	page, err = reader.Tasks(ctx, f.project, store.TaskQuery{Parent: &none, Page: store.Page{Limit: 1}})
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != independent || page.HasMore {
		t.Fatalf("independent page: %+v", page)
	}
	priority, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Parent: &goal, Limit: 1})
	mustOK(t, err)
	if len(priority.Items) != 1 || !priority.HasMore {
		t.Fatalf("parent priority: %+v", priority)
	}
	for _, item := range priority.Items {
		if item.Task.ParentID == nil || *item.Task.ParentID != goal {
			t.Fatalf("priority item: %+v", item)
		}
	}
	search := task.NewSearchSnapshot(f.tx)
	expression := &searchmodel.Node{Kind: searchmodel.Leaf, Atom: searchmodel.Atom{Field: searchmodel.TitleField, Term: "needle"}}
	matches, err := search.Matches(ctx, f.project, store.TaskSearchQuery{Expression: expression, Parent: &goal, Limit: 1})
	mustOK(t, err)
	if matches.Total != 2 || len(matches.Items) != 1 || !matches.HasMore {
		t.Fatalf("parent search: %+v", matches)
	}
	matches, err = search.Matches(ctx, f.project, store.TaskSearchQuery{Expression: expression, Type: model.TaskTypeGoal, Limit: 1})
	mustOK(t, err)
	if matches.Total != 1 || len(matches.Items) != 1 || matches.Items[0].ID != goal {
		t.Fatalf("goal search: %+v", matches)
	}
	titles, err := search.Titles(ctx, f.project, []string{goal, deletedGoal, first})
	mustOK(t, err)
	if len(titles) != 1 || titles[goal] != "needle goal" {
		t.Fatalf("parent titles: %+v", titles)
	}
	graph, err := reader.TaskGraphTasks(ctx, f.project, first, store.TaskGraphSelection{OrdinaryPrerequisites: true, LiveOnly: true}, 160)
	mustOK(t, err)
	if len(graph) != 1 || graph[0].ID != first {
		t.Fatalf("hidden graph node: %+v", graph)
	}
	before, err := search.Fence(ctx, f.project)
	mustOK(t, err)
	listBefore, err := reader.TaskListFence(ctx, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET title='renamed',version=version+1 WHERE id=$1`, goal)
	mustOK(t, err)
	after, err := search.Fence(ctx, f.project)
	mustOK(t, err)
	listAfter, err := reader.TaskListFence(ctx, f.project)
	mustOK(t, err)
	if before == after || listBefore == listAfter {
		t.Fatal("Goal change did not invalidate both fences")
	}
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET status='done',version=version+1 WHERE id=$1`, first)
	mustOK(t, err)
	last, err := search.Fence(ctx, f.project)
	mustOK(t, err)
	listLast, err := reader.TaskListFence(ctx, f.project)
	mustOK(t, err)
	if after == last || listAfter == listLast {
		t.Fatal("child change did not invalidate both fences")
	}
}
