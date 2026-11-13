//go:build stress

package tasksearch

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type contextStressFacts struct {
	t          *testing.T
	project    string
	principal  model.Principal
	page       store.TaskSearchPage
	graph      store.TaskSearchGraph
	after      *store.TaskSearchPosition
	limit      int
	titles     map[string]string
	titleIDs   []string
	calls      []string
	position   int
	graphReads int
}

func (f *contextStressFacts) called(ctx context.Context, project, name string) {
	f.t.Helper()
	if ctx.Err() != nil || project != f.project || f.position >= len(f.calls) || f.calls[f.position] != name {
		f.t.Fatalf("unexpected context operation: project=%s name=%s position=%d context=%v", project, name, f.position, ctx.Err())
	}
	f.position++
}

func (f *contextStressFacts) ReadTaskSearch(ctx context.Context, read func(store.TaskSearchSnapshot) error) error {
	f.called(ctx, f.project, "scope")
	return read(f)
}

func (f *contextStressFacts) ProjectAccess(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	f.called(ctx, project, "access")
	if principal != f.principal {
		f.t.Fatalf("different context principal: %#v", principal)
	}
	return model.ProjectAccess{ProjectID: project, UserID: principal.UserID, Role: model.ProjectAdmin}, nil
}

func (f *contextStressFacts) ResolveTags(context.Context, string, []string) ([]model.Tag, error) {
	f.t.Fatal("unexpected tag resolution")
	return nil, nil
}

func (f *contextStressFacts) Fence(ctx context.Context, project string) (store.TaskSearchFence, error) {
	f.called(ctx, project, "fence")
	return store.TaskSearchFence{Epoch: user, Count: "3303", VersionSum: "3303"}, nil
}

func (f *contextStressFacts) Matches(ctx context.Context, project string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	f.called(ctx, project, "matches")
	if input.Limit != f.limit || !reflect.DeepEqual(input.After, f.after) {
		f.t.Fatalf("different planned context query: %#v", input)
	}
	return f.page, nil
}

func (f *contextStressFacts) ContextGraph(ctx context.Context, project string, ids []string) (store.TaskSearchGraph, error) {
	f.called(ctx, project, "graph")
	f.graphReads++
	expected := make([]string, 0, len(f.page.Items))
	for _, row := range f.page.Items {
		expected = append(expected, row.ID)
	}
	if !reflect.DeepEqual(ids, expected) {
		f.t.Fatalf("different planned graph seeds: %v want %v", ids, expected)
	}
	return f.graph, nil
}

func (f *contextStressFacts) Titles(ctx context.Context, project string, ids []string) (map[string]string, error) {
	f.called(ctx, project, "titles")
	if !reflect.DeepEqual(ids, f.titleIDs) {
		f.t.Fatalf("different planned representatives: %v want %v", ids, f.titleIDs)
	}
	return f.titles, nil
}

func contextStressID(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

func TestSearchManyComponentsContextStress(t *testing.T) {
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	actor := principal()
	for _, connected := range []bool{false, true} {
		seen := map[string]bool{}
		var cursor *string
		var after *store.TaskSearchPosition
		for offset := 0; offset < 1101; offset += 100 {
			facts := &contextStressFacts{t: t, project: projectID, principal: actor, limit: 100, after: after, calls: []string{"scope", "access", "fence", "matches", "graph"}, page: store.TaskSearchPage{Total: 1101, HasMore: offset+100 < 1101}, titles: map[string]string{}}
			queryText := "title:standalone"
			if connected {
				queryText = "title:componenttarget"
				facts.calls = append(facts.calls, "titles")
			}
			for index := offset; index < min(offset+100, 1101); index++ {
				id, representative := contextStressID(index+1), contextStressID(index+2001)
				title := "standalone"
				if connected {
					title = "componenttarget"
				}
				facts.page.Items = append(facts.page.Items, store.TaskSearchRow{ID: id, Title: title, Status: model.TaskTodo, TitlePriority: true, UpdatedAt: stamp.Add(time.Duration(index) * time.Microsecond)})
				facts.graph.Nodes = append(facts.graph.Nodes, store.TaskSearchNode{ID: id, CreatedAt: stamp.Add(time.Second)})
				if connected {
					facts.graph.Nodes = append(facts.graph.Nodes, store.TaskSearchNode{ID: representative, CreatedAt: stamp})
					facts.graph.Edges = append(facts.graph.Edges, store.TaskSearchEdge{TaskID: id, DependsOnID: representative})
					facts.titleIDs = append(facts.titleIDs, representative)
					facts.titles[representative] = "componentroot"
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			page, err := Search(ctx, facts, actor, projectID, Request{Query: queryText, Limit: 100, Cursor: cursor})
			cancel()
			if err != nil || page.Total != 1101 || facts.position != len(facts.calls) {
				t.Fatalf("context page: total=%d calls=%d/%d error=%v", page.Total, facts.position, len(facts.calls), err)
			}
			for _, item := range page.Items {
				if seen[item.ID] || (item.Context != nil) != connected {
					t.Fatalf("bad context item: %#v", item)
				}
				seen[item.ID] = true
			}
			if (page.NextCursor != nil) != facts.page.HasMore {
				t.Fatalf("context continuation differs from planned page: %#v", page)
			}
			cursor = page.NextCursor
			last := facts.page.Items[len(facts.page.Items)-1]
			after = &store.TaskSearchPosition{ID: last.ID, UpdatedAt: last.UpdatedAt, TitlePriority: last.TitlePriority}
		}
		if len(seen) != 1101 {
			t.Fatalf("seen %d", len(seen))
		}
	}
}

func TestSearchLinearContextStress(t *testing.T) {
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	seed := contextStressID(1)
	facts := &contextStressFacts{t: t, project: projectID, principal: principal(), limit: 10, calls: []string{"scope", "access", "fence", "matches", "graph", "titles"}, page: store.TaskSearchPage{Total: 1, Items: []store.TaskSearchRow{{ID: seed, Title: "linearroot", Status: model.TaskTodo, TitlePriority: true, UpdatedAt: stamp}}}, titleIDs: []string{seed}, titles: map[string]string{seed: "linearroot"}}
	for index := 1; index <= 20000; index++ {
		facts.graph.Nodes = append(facts.graph.Nodes, store.TaskSearchNode{ID: contextStressID(index), CreatedAt: stamp.Add(time.Duration(index) * time.Microsecond)})
		if index > 1 {
			facts.graph.Edges = append(facts.graph.Edges, store.TaskSearchEdge{TaskID: contextStressID(index), DependsOnID: contextStressID(index - 1)})
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	page, err := Search(ctx, facts, facts.principal, projectID, Request{Query: "title:linearroot", Limit: 10})
	if err != nil || facts.graphReads != 1 || page.NodeCount != 20000 || len(page.Items) != 1 || page.Items[0].Context == nil || page.Items[0].Context.TaskID != seed || facts.position != len(facts.calls) {
		t.Fatalf("linear result %#v; graph reads=%d calls=%d/%d error=%v", page, facts.graphReads, facts.position, len(facts.calls), err)
	}
}
