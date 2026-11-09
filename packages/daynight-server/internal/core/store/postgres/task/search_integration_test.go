package task_test

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"testing"
)

func atom(field tasksearch.Field, term string) *tasksearch.Node {
	return &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: field, Term: term}}
}
func TestSearchSnapshotMatchingPaginationAndContext(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	s := task.NewSearchSnapshot(f.tx)
	a := mustTask(t, w, store.TaskWrite{Title: "Alpha title", Description: "red", AllowAgents: true})
	b := mustTask(t, w, store.TaskWrite{Title: "second", Description: "alpha red", DependsOn: []string{a.ID}, AssignedTo: &f.user})
	c := mustTask(t, w, store.TaskWrite{Title: "Alpha blue", Description: "blue", Status: model.TaskDone})
	d := mustTask(t, w, store.TaskWrite{Title: "external alpha"})
	_, e := w.UpdateTask(ctx, b.ID, store.TaskWrite{Title: b.Title, Description: b.Description, Status: model.TaskTodo, DependsOn: []string{a.ID, d.ID}, ExternalDependsOn: []string{d.ID}, AssignedTo: &f.user})
	mustOK(t, e)
	mustTask(t, task.NewWriter(f.tx, f.other), store.TaskWrite{Title: "alpha foreign"})
	access, e := s.ProjectAccess(ctx, model.Principal{UserID: f.user}, f.project)
	mustOK(t, e)
	if access.UserID != f.user || access.Role != model.ProjectAdmin {
		t.Fatalf("access: %+v", access)
	}
	fence, e := s.Fence(ctx, f.project)
	mustOK(t, e)
	if fence.Epoch == "" || fence.Count != "4" || fence.VersionSum != "5" {
		t.Fatalf("search fence: %+v", fence)
	}
	page, e := s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), Limit: 3})
	mustOK(t, e)
	if page.Total != 4 || len(page.Items) != 3 || !page.HasMore {
		t.Fatalf("search page: %+v", page)
	}
	for _, v := range page.Items {
		if !v.TitlePriority {
			t.Fatalf("description match precedes title: %+v", page)
		}
	}
	last := page.Items[2]
	page, e = s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), Limit: 3, After: &store.TaskSearchPosition{ID: last.ID, UpdatedAt: last.UpdatedAt, TitlePriority: last.TitlePriority}})
	mustOK(t, e)
	if page.Total != 4 || len(page.Items) != 1 || page.Items[0].ID != b.ID || page.Items[0].TitlePriority || page.HasMore {
		t.Fatalf("continuation: %+v", page)
	}
	cases := []struct {
		name string
		expr *tasksearch.Node
		ids  []string
	}{
		{"title", atom(tasksearch.TitleField, "alpha"), []string{a.ID, c.ID, d.ID}},
		{"description", atom(tasksearch.DescriptionField, "red"), []string{a.ID, b.ID}},
		{"and", &tasksearch.Node{Kind: tasksearch.And, Left: atom(tasksearch.AnyField, "alpha"), Right: atom(tasksearch.DescriptionField, "red")}, []string{a.ID, b.ID}},
		{"or", &tasksearch.Node{Kind: tasksearch.Or, Left: atom(tasksearch.TitleField, "second"), Right: atom(tasksearch.DescriptionField, "blue")}, []string{b.ID, c.ID}},
		{"negation", &tasksearch.Node{Kind: tasksearch.And, Left: atom(tasksearch.AnyField, "alpha"), Right: &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.AnyField, Term: "blue"}, Negated: true}}, []string{a.ID, b.ID, d.ID}},
		{"duplicate", &tasksearch.Node{Kind: tasksearch.And, Left: atom(tasksearch.TitleField, "alpha"), Right: atom(tasksearch.TitleField, "alpha")}, []string{a.ID, c.ID, d.ID}},
		{"nul", atom(tasksearch.AnyField, "\x00"), []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			page, e := s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: c.expr, Limit: 100})
			mustOK(t, e)
			seen := map[string]bool{}
			for _, v := range page.Items {
				seen[v.ID] = true
			}
			if len(seen) != len(c.ids) || page.Total != int64(len(c.ids)) {
				t.Fatalf("matches: %+v", page)
			}
			for _, id := range c.ids {
				if !seen[id] {
					t.Fatalf("missing %s: %+v", id, page)
				}
			}
		})
	}
	for _, filter := range []model.TaskAssignmentFilter{{Mode: model.TaskAssignmentUnassigned}, {Mode: model.TaskAssignmentUser, UserID: f.user}} {
		p, e := s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), Limit: 100, AssignedTo: filter})
		mustOK(t, e)
		want := int64(3)
		if filter.Mode == model.TaskAssignmentUser {
			want = 1
		}
		if p.Total != want {
			t.Fatalf("filtered search: %+v", p)
		}
	}
	ready := true
	p, e := s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), Limit: 100, Ready: &ready, AllowAgents: &ready})
	mustOK(t, e)
	if p.Total != 1 || p.Items[0].ID != a.ID {
		t.Fatalf("ready search: %+v", p)
	}
	size, e := s.ContextSize(ctx, f.project, []string{a.ID})
	mustOK(t, e)
	if size.NodeCount != 2 || size.EdgeCount != 1 {
		t.Fatalf("ordinary closure: %+v", size)
	}
	graph, e := s.ContextGraph(ctx, f.project, []string{a.ID})
	mustOK(t, e)
	if len(graph.Nodes) != 2 || len(graph.Edges) != 1 || graph.Edges[0].TaskID != b.ID || graph.Edges[0].DependsOnID != a.ID {
		t.Fatalf("context graph: %+v", graph)
	}
	titles, e := s.Titles(ctx, f.project, []string{a.ID, b.ID})
	mustOK(t, e)
	if titles[a.ID] != a.Title || titles[b.ID] != b.Title {
		t.Fatalf("titles: %v", titles)
	}
	_, e = w.DeleteTask(ctx, a.ID, false)
	mustOK(t, e)
	if _, e = s.Titles(ctx, f.project, []string{a.ID}); e == nil {
		t.Fatal("deleted context title accepted")
	}
	size, e = s.ContextSize(ctx, f.project, []string{a.ID})
	mustOK(t, e)
	if size.NodeCount != 0 {
		t.Fatal("deleted root retained")
	}
	for _, bad := range []*tasksearch.Node{nil, atom(tasksearch.AnyField, ""), atom(tasksearch.Field(9), "a"), {Kind: tasksearch.Kind(9)}, {Kind: tasksearch.And, Left: nil, Right: atom(tasksearch.AnyField, "a")}} {
		if _, e = s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: bad, Limit: 1}); e == nil {
			t.Fatalf("invalid expression accepted: %+v", bad)
		}
	}
	if _, e = s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "a"), Limit: 0}); e == nil {
		t.Fatal("invalid limit accepted")
	}
	if _, e = s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "a"), Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: "bad"}}); e == nil {
		t.Fatal("invalid assignment accepted")
	}
}
