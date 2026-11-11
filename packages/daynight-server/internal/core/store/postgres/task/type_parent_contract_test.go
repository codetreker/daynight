package task_test

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestTypedResourceMappings(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	goal, child := uuid.NewString(), uuid.NewString()
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,title,type,parent_id) VALUES($1,$3,'Example goal','goal',NULL),($2,$3,'Example child','task',$1)`, goal, child, f.project)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	full, err := reader.Task(ctx, f.project, child)
	if err != nil || full.Type != model.TaskTypeTask || full.ParentID == nil || *full.ParentID != goal {
		t.Fatalf("full child: %+v, %v", full, err)
	}
	full, err = reader.Task(ctx, f.project, goal)
	if err != nil || full.Type != model.TaskTypeGoal || full.ParentID != nil {
		t.Fatalf("full goal: %+v, %v", full, err)
	}
	page, err := reader.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10}})
	mustOK(t, err)
	if len(page.Items) != 2 {
		t.Fatalf("list: %+v", page)
	}
	for _, item := range page.Items {
		if item.ID == child && (item.Type != model.TaskTypeTask || item.ParentID == nil || *item.ParentID != goal) {
			t.Fatalf("list child: %+v", item)
		}
		if item.ID == goal && (item.Type != model.TaskTypeGoal || item.ParentID != nil) {
			t.Fatalf("list goal: %+v", item)
		}
	}
	priority, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 10})
	mustOK(t, err)
	if len(priority.Items) != 2 {
		t.Fatalf("priority list: %+v", priority)
	}
	for _, entry := range priority.Items {
		item := entry.Task
		if item.ID == child && (item.Type != model.TaskTypeTask || item.ParentID == nil || *item.ParentID != goal) {
			t.Fatalf("priority child: %+v", item)
		}
		if item.ID == goal && (item.Type != model.TaskTypeGoal || item.ParentID != nil) {
			t.Fatalf("priority goal: %+v", item)
		}
	}
	graph, err := reader.TaskGraphTasks(ctx, f.project, child, store.TaskGraphSelection{LiveOnly: true}, 160)
	if err != nil || len(graph) != 1 || graph[0].Type != model.TaskTypeTask || graph[0].ParentID == nil || *graph[0].ParentID != goal {
		t.Fatalf("graph: %+v %v", graph, err)
	}
	sync, err := reader.TaskSyncTasks(ctx, f.project, nil, 160)
	mustOK(t, err)
	if len(sync) != 2 {
		t.Fatalf("sync: %+v", sync)
	}
	for _, item := range sync {
		if item.ID == child && (item.Type != model.TaskTypeTask || item.ParentID == nil || *item.ParentID != goal) {
			t.Fatalf("sync child: %+v", item)
		}
		if item.ID == goal && (item.Type != model.TaskTypeGoal || item.ParentID != nil) {
			t.Fatalf("sync goal: %+v", item)
		}
	}
	search := task.NewSearchSnapshot(f.tx)
	rows, err := search.Matches(ctx, f.project, store.TaskSearchQuery{Expression: &searchmodel.Node{Kind: searchmodel.Leaf, Atom: searchmodel.Atom{Field: searchmodel.TitleField, Term: "example"}}, Limit: 10})
	mustOK(t, err)
	if len(rows.Items) != 2 {
		t.Fatalf("search: %+v", rows)
	}
	for _, item := range rows.Items {
		if item.ID == child && (item.Type != model.TaskTypeTask || item.ParentID == nil || *item.ParentID != goal) {
			t.Fatalf("search child: %+v", item)
		}
		if item.ID == goal && (item.Type != model.TaskTypeGoal || item.ParentID != nil) {
			t.Fatalf("search goal: %+v", item)
		}
	}
}
