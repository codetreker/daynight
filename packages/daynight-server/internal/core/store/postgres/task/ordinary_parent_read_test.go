package task_test

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestOrdinaryParentReadPathsAndFiveStateSelection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	goal, parent := uuid.NewString(), uuid.NewString()
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,parent_id,status) VALUES
 ($1,$3,'goal','needle Goal',NULL,'todo'),($2,$3,'task','needle Parent',$1,'todo')`, goal, parent, f.project)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	badParent := "not-a-uuid"
	for _, selection := range []store.TaskQuery{
		{Type: model.TaskTypeGoal, ParentTask: &parent, Page: store.Page{Limit: 2}},
		{Parent: &goal, ParentTask: &parent, Page: store.Page{Limit: 2}},
		{ParentTask: &badParent, Page: store.Page{Limit: 2}},
	} {
		if _, err := reader.Tasks(ctx, f.project, selection); err == nil {
			t.Fatalf("invalid parent selection accepted: %+v", selection)
		}
	}
	ids := make([]string, 0, 5)
	for i, status := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		id := uuid.NewString()
		ids = append(ids, id)
		_, err = f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,parent_id,status,created_at,assigned_to,cancelled_at) VALUES($1,$2,'task','needle child',$3,$4,$5,$6,CASE WHEN $4='cancelled' THEN $5::timestamptz ELSE NULL END)`, id, f.project, parent, status, time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC), f.user)
		mustOK(t, err)
	}
	// Ordinary parent edges do not expand dependency-based Task Chains.
	graph, err := reader.TaskGraphTasks(ctx, f.project, ids[0], store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, LiveOnly: true}, 160)
	mustOK(t, err)
	if len(graph) != 1 || graph[0].ParentType != model.TaskTypeTask || graph[0].ParentID == nil || *graph[0].ParentID != parent {
		t.Fatalf("graph: %+v", graph)
	}
	var after *store.Position
	got := []string{}
	for {
		page, err := reader.Tasks(ctx, f.project, store.TaskQuery{ParentTask: &parent, Page: store.Page{Limit: 2, After: after}})
		mustOK(t, err)
		for _, row := range page.Items {
			if row.ParentType != model.TaskTypeTask || row.ParentID == nil || *row.ParentID != parent {
				t.Fatalf("list projection: %+v", row)
			}
			got = append(got, row.ID)
		}
		if !page.HasMore {
			break
		}
		last := page.Items[len(page.Items)-1]
		after = &store.Position{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	if len(got) != 5 {
		t.Fatalf("five-state pagination: %v", got)
	}
	none := "none"
	page, err := reader.Tasks(ctx, f.project, store.TaskQuery{Parent: &none, Page: store.Page{Limit: 100}})
	mustOK(t, err)
	if len(page.Items) != 5 {
		t.Fatalf("legacy no-Goal filter excluded ordinary children: %+v", page)
	}
	page, err = reader.Tasks(ctx, f.project, store.TaskQuery{Parent: &goal, Page: store.Page{Limit: 100}})
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != parent || page.Items[0].ParentType != model.TaskTypeGoal {
		t.Fatalf("Goal children: %+v", page)
	}
	priority, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{ParentTask: &parent, Limit: 100})
	mustOK(t, err)
	if len(priority.Items) != 5 {
		t.Fatalf("priority children: %+v", priority)
	}
	status, ready := model.TaskTodo, true
	priority, err = reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{ParentTask: &parent, Status: &status, Ready: &ready, Limit: 100})
	mustOK(t, err)
	if len(priority.Items) != 1 || priority.Items[0].Task.ID != ids[1] {
		t.Fatalf("Ready ordinary child: %+v", priority)
	}
	search := task.NewSearchSnapshot(f.tx)
	matches, err := search.Matches(ctx, f.project, store.TaskSearchQuery{ParentTask: &parent, Expression: &searchmodel.Node{Kind: searchmodel.Leaf, Atom: searchmodel.Atom{Field: searchmodel.TitleField, Term: "needle"}}, Limit: 2})
	mustOK(t, err)
	if matches.Total != 5 || len(matches.Items) != 2 || !matches.HasMore || matches.Items[0].ParentType != model.TaskTypeTask {
		t.Fatalf("search: %+v", matches)
	}
	titles, err := search.Titles(ctx, f.project, []string{goal, parent})
	mustOK(t, err)
	if titles[parent] != "needle Parent" || titles[goal] != "needle Goal" {
		t.Fatalf("direct parent titles: %v", titles)
	}
	sync, err := reader.TaskSyncTasks(ctx, f.project, nil, 160)
	mustOK(t, err)
	found := 0
	for _, row := range sync {
		if row.ParentType == model.TaskTypeTask {
			found++
		}
	}
	if found != 5 {
		t.Fatalf("sync ordinary parent rows: %d", found)
	}
	personal, err := reader.(store.PersonalTaskReader).PersonalTaskPage(ctx, f.user, store.PersonalTaskQuery{Limit: 100})
	mustOK(t, err)
	if len(personal.Items) != 1 || personal.Items[0].ID != ids[2] || personal.Items[0].GoalID != nil || personal.Items[0].GoalTitle != nil {
		t.Fatalf("My Tasks direct Goal pairing: %+v", personal)
	}
	full, err := reader.Task(ctx, f.project, ids[2])
	mustOK(t, err)
	if full.ParentType != model.TaskTypeTask || full.ParentID == nil || *full.ParentID != parent {
		t.Fatalf("full projection: %+v", full)
	}
	progress, err := reader.GoalProgresses(ctx, f.project, []string{goal})
	mustOK(t, err)
	if progress[goal].Total != 1 {
		t.Fatalf("Goal progress counted descendants: %+v", progress)
	}
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET ancestor_deleted_at=now() WHERE id=ANY($1::uuid[])`, ids)
	mustOK(t, err)
	page, err = reader.Tasks(ctx, f.project, store.TaskQuery{ParentTask: &parent, Page: store.Page{Limit: 100}})
	mustOK(t, err)
	if len(page.Items) != 0 {
		t.Fatalf("hidden descendants listed: %+v", page)
	}
	page, err = reader.Tasks(ctx, f.other, store.TaskQuery{ParentTask: &parent, Page: store.Page{Limit: 100}})
	mustOK(t, err)
	if len(page.Items) != 0 {
		t.Fatalf("cross-project children listed: %+v", page)
	}
}
