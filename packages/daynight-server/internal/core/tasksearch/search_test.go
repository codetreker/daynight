package tasksearch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const user = "11111111-1111-4111-8111-111111111111"
const projectID = "22222222-2222-4222-8222-222222222222"
const root = "33333333-3333-4333-8333-333333333333"
const child = "44444444-4444-4444-8444-444444444444"

type searchFixture struct {
	fence       store.TaskSearchFence
	rows        store.TaskSearchPage
	graph       store.TaskSearchGraph
	size        store.TaskSearchSize
	denied      bool
	graphCalled bool
	completion  error
}

func (f *searchFixture) ReadTaskSearch(ctx context.Context, fn func(store.TaskSearchSnapshot) error) error {
	if err := fn(f); err != nil {
		return err
	}
	return f.completion
}
func (f *searchFixture) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	if f.denied {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	return model.ProjectAccess{}, nil
}
func (f *searchFixture) Fence(context.Context, string) (store.TaskSearchFence, error) {
	return f.fence, nil
}
func (f *searchFixture) Matches(context.Context, string, store.TaskSearchQuery) (store.TaskSearchPage, error) {
	return f.rows, nil
}
func (f *searchFixture) ContextSize(context.Context, string, []string) (store.TaskSearchSize, error) {
	return f.size, nil
}
func (f *searchFixture) ContextGraph(context.Context, string, []string) (store.TaskSearchGraph, error) {
	f.graphCalled = true
	return f.graph, nil
}
func (f *searchFixture) Titles(context.Context, string, []string) (map[string]string, error) {
	return map[string]string{root: "Goal"}, nil
}
func principal() model.Principal {
	return model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: user}
}
func testFixture() *searchFixture {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return &searchFixture{fence: store.TaskSearchFence{Epoch: user, Count: "2", VersionSum: "2"}, rows: store.TaskSearchPage{Total: 2, HasMore: true, Items: []store.TaskSearchRow{{ID: child, Title: "Cache", Description: "raw markdown", Status: model.TaskDone, UpdatedAt: now, TitlePriority: true}}}, size: store.TaskSearchSize{NodeCount: 2, EdgeCount: 1}, graph: store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: child, CreatedAt: now}, {ID: root, CreatedAt: now.Add(-time.Hour)}}, Edges: []store.TaskSearchEdge{{TaskID: child, DependsOnID: root}}}}
}
func TestSearchPageAndCursor(t *testing.T) {
	f := testFixture()
	request := Request{Query: "cache", Limit: 1}
	page, err := Search(context.Background(), f, principal(), projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 1 || page.NextCursor == nil || page.Items[0].Context == nil || page.Items[0].Context.TaskID != root || len(page.Items[0].Match.Fields) != 1 || page.Items[0].Match.Fields[0] != "title" {
		t.Fatalf("unexpected page %+v", page)
	}
	request.Cursor = page.NextCursor
	f.fence.VersionSum = "3"
	_, err = Search(context.Background(), f, principal(), projectID, request)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "search_changed" {
		t.Fatalf("expected change, got %v", err)
	}
	f.denied = true
	_, err = Search(context.Background(), f, principal(), projectID, request)
	if !errors.As(err, &fault) || fault.Code == "search_changed" {
		t.Fatalf("permission should precede fence: %v", err)
	}
	f.denied = false
	request.Query = "other"
	_, err = Search(context.Background(), f, principal(), projectID, request)
	if !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("scope not bound: %v", err)
	}
}
func TestSearchLimitsAndCompletion(t *testing.T) {
	f := testFixture()
	f.size.NodeCount = MaxNodes + 1
	_, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "search_context_limit_exceeded" || f.graphCalled {
		t.Fatalf("overflow must reject before graph: %v %+v", err, f)
	}
	f = testFixture()
	f.completion = errors.New("commit failed")
	_, err = Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
	if !errors.Is(err, f.completion) {
		t.Fatalf("completion failure hidden: %v", err)
	}
}
func TestComponents(t *testing.T) {
	now := time.Now()
	graph := store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: root, CreatedAt: now}, {ID: child, CreatedAt: now}}, Edges: []store.TaskSearchEdge{{TaskID: child, DependsOnID: root}}}
	r, err := componentRepresentatives(context.Background(), graph, []string{root, child})
	if err != nil || r[root] != root || r[child] != root {
		t.Fatalf("%v %v", r, err)
	}
	graph.Edges = nil
	r, err = componentRepresentatives(context.Background(), graph, []string{root})
	if err != nil || r[root] != "" {
		t.Fatalf("%v %v", r, err)
	}
}

func TestComponentsHonorCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := componentRepresentatives(ctx, store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: root}}}, []string{root})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}
