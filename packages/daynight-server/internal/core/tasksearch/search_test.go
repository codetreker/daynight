package tasksearch

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"strings"
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
	fence         store.TaskSearchFence
	rows          store.TaskSearchPage
	graph         store.TaskSearchGraph
	denied        bool
	graphCalled   bool
	completion    error
	failurePhase  string
	failure       error
	missingTitles bool
	onTitles      func()
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
	if f.failurePhase == "fence" {
		return store.TaskSearchFence{}, f.failure
	}
	return f.fence, nil
}
func (f *searchFixture) Matches(context.Context, string, store.TaskSearchQuery) (store.TaskSearchPage, error) {
	if f.failurePhase == "matches" {
		return store.TaskSearchPage{}, f.failure
	}
	return f.rows, nil
}
func (f *searchFixture) ContextGraph(context.Context, string, []string) (store.TaskSearchGraph, error) {
	f.graphCalled = true
	if f.failurePhase == "graph" {
		return store.TaskSearchGraph{}, f.failure
	}
	return f.graph, nil
}
func (f *searchFixture) Titles(context.Context, string, []string) (map[string]string, error) {
	if f.onTitles != nil {
		f.onTitles()
	}
	if f.failurePhase == "titles" {
		return nil, f.failure
	}
	if f.missingTitles {
		return map[string]string{}, nil
	}
	return map[string]string{root: "Goal"}, nil
}
func principal() model.Principal {
	return model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: user}
}
func testFixture() *searchFixture {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return &searchFixture{fence: store.TaskSearchFence{Epoch: user, Count: "2", VersionSum: "2"}, rows: store.TaskSearchPage{Total: 2, HasMore: true, Items: []store.TaskSearchRow{{ID: child, Title: "Cache", Description: "raw markdown", Status: model.TaskDone, UpdatedAt: now, TitlePriority: true}}}, graph: store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: child, CreatedAt: now}, {ID: root, CreatedAt: now.Add(-time.Hour)}}, Edges: []store.TaskSearchEdge{{TaskID: child, DependsOnID: root}}}}
}
func TestSearchPageAndCursor(t *testing.T) {
	f := testFixture()
	parent := root
	f.rows.Items[0].Type = model.TaskTypeTask
	f.rows.Items[0].ParentID = &parent
	request := Request{Query: "cache", Limit: 1}
	page, err := Search(context.Background(), f, principal(), projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 1 || page.Items[0].Type != model.TaskTypeTask || page.Items[0].ParentID == nil || *page.Items[0].ParentID != root || page.NextCursor == nil || page.Items[0].Context == nil || page.Items[0].Context.TaskID != root || len(page.Items[0].Match.Fields) != 1 || page.Items[0].Match.Fields[0] != "title" {
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
func TestSearchCompletion(t *testing.T) {
	f := testFixture()
	f.completion = errors.New("commit failed")
	_, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
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

func TestSearchInvalidRequests(t *testing.T) {
	badStatus := model.TaskStatus("unknown")
	badPlatform := model.TaskPlatform("unknown")
	badAssignee := "bad"
	cases := []struct {
		name, project string
		principal     model.Principal
		input         Request
		code          string
	}{
		{"principal", projectID, model.Principal{}, Request{Query: "cache", Limit: 1}, "unauthenticated"},
		{"project", "bad", principal(), Request{Query: "cache", Limit: 1}, "invalid_input"},
		{"limit", projectID, principal(), Request{Query: "cache", Limit: 0}, "invalid_input"},
		{"status", projectID, principal(), Request{Query: "cache", Limit: 1, Status: &badStatus}, "invalid_input"},
		{"platform", projectID, principal(), Request{Query: "cache", Limit: 1, CompatiblePlatform: &badPlatform}, "invalid_input"},
		{"assignee", projectID, principal(), Request{Query: "cache", Limit: 1, AssignedTo: &badAssignee}, "invalid_input"},
		{"syntax", projectID, principal(), Request{Query: "(", Limit: 1}, "invalid_search_expression"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Search(context.Background(), testFixture(), tc.principal, tc.project, tc.input)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != tc.code {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestSearchSnapshotFailuresAreNotSuccess(t *testing.T) {
	for _, phase := range []string{"fence", "matches", "graph", "titles"} {
		t.Run(phase, func(t *testing.T) {
			f := testFixture()
			f.failurePhase = phase
			f.failure = errors.New("read failed")
			_, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
			if !errors.Is(err, f.failure) {
				t.Fatalf("%s: %v", phase, err)
			}
		})
	}
	t.Run("empty continuation", func(t *testing.T) {
		f := testFixture()
		f.rows.Items = nil
		if _, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1}); err == nil {
			t.Fatal("missing continuation position accepted")
		}
	})
	t.Run("cancel during assembly", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		f := testFixture()
		f.onTitles = cancel
		if _, err := Search(ctx, f, principal(), projectID, Request{Query: "cache", Limit: 1}); !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("description evidence", func(t *testing.T) {
		f := testFixture()
		row := &f.rows.Items[0]
		row.Title = "other"
		row.Description = "before cache after"
		row.TitlePriority = false
		page, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
		if err != nil || len(page.Items) != 1 || len(page.Items[0].Match.Fields) != 1 || page.Items[0].Match.Fields[0] != "description" || page.Items[0].Match.DescriptionSnippet == nil {
			t.Fatalf("page=%+v err=%v", page, err)
		}
	})
}

func TestSearchCursorValidation(t *testing.T) {
	scope := cursorScope{Version: 2, UserID: user, ProjectID: projectID, QueryHash: "hash"}
	valid := cursor{Scope: scope, Fence: store.TaskSearchFence{Epoch: user, Count: "0", VersionSum: "123456789012345678901234567890"}, Position: store.TaskSearchPosition{ID: child, UpdatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}}
	encoded, err := encodeCursor(valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = decodeCursor(encoded, scope); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "-1", "+1", "01", "1.0"} {
		t.Run("decimal_"+value, func(t *testing.T) {
			v := valid
			v.Fence.Count = value
			s, err := encodeCursor(v)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = decodeCursor(s, scope); err == nil {
				t.Fatalf("accepted count %q", value)
			}
		})
	}
	for name, mutation := range map[string]func(*cursor){"id": func(v *cursor) { v.Position.ID = "bad" }, "epoch": func(v *cursor) { v.Fence.Epoch = "bad" }, "time": func(v *cursor) { v.Position.UpdatedAt = time.Time{} }, "scope": func(v *cursor) { v.Scope.ProjectID = root }, "sum": func(v *cursor) { v.Fence.VersionSum = "not-a-number" }} {
		t.Run(name, func(t *testing.T) {
			v := valid
			mutation(&v)
			s, err := encodeCursor(v)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = decodeCursor(s, scope); err == nil {
				t.Fatal("invalid cursor accepted")
			}
		})
	}
	for _, value := range []string{"!", strings.Repeat("a", 16385), base64.RawURLEncoding.EncodeToString([]byte(`{"extra":1}`)), base64.RawURLEncoding.EncodeToString([]byte(`{} {}`))} {
		if _, err := decodeCursor(value, scope); err == nil {
			t.Fatalf("accepted malformed cursor %q", value[:min(len(value), 20)])
		}
	}
	valid.Position.UpdatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := encodeCursor(valid); err == nil {
		t.Fatal("unencodable time accepted")
	}
}

func TestSearchIDEvidenceAndContinuation(t *testing.T) {
	const id = child
	f := testFixture()
	f.rows.Items[0].TitlePriority = false
	f.rows.Items[0].ExactIDPriority = true
	page, err := Search(context.Background(), f, principal(), projectID, Request{Query: "id:" + id, Limit: 1})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0].Match.Fields, []string{"id"}) || page.Items[0].Match.DescriptionSnippet != nil || page.NextCursor == nil {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	scope := cursorScope{Version: 2, UserID: user, ProjectID: projectID, QueryHash: fmt.Sprintf("%x", sha256.Sum256([]byte("id:"+id))), AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}}
	value, err := decodeCursor(*page.NextCursor, scope)
	if err != nil || !value.Position.ExactIDPriority || value.Position.TitlePriority || value.Position.ID != id {
		t.Fatalf("position=%+v err=%v", value.Position, err)
	}

}

func TestSearchCursorV2RequiresCanonicalExactPriority(t *testing.T) {
	scope := cursorScope{Version: 2, UserID: user, ProjectID: projectID, QueryHash: "hash"}
	c := cursor{Scope: scope, Fence: store.TaskSearchFence{Epoch: user, Count: "1", VersionSum: "1"}, Position: store.TaskSearchPosition{ID: child, UpdatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}}
	encoded, err := encodeCursor(c)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"missing":     strings.Replace(string(raw), `"ExactIDPriority":false,`, "", 1),
		"null":        strings.Replace(string(raw), `"ExactIDPriority":false`, `"ExactIDPriority":null`, 1),
		"wrong type":  strings.Replace(string(raw), `"ExactIDPriority":false`, `"ExactIDPriority":"false"`, 1),
		"old version": strings.Replace(string(raw), `"version":2`, `"version":1`, 1),
		"duplicate":   strings.Replace(string(raw), `"ExactIDPriority":false`, `"ExactIDPriority":false,"ExactIDPriority":false`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeCursor(base64.RawURLEncoding.EncodeToString([]byte(value)), scope); err == nil {
				t.Fatal("invalid cursor accepted")
			}
		})
	}
	if _, err := decodeCursor(encoded, scope); err != nil {
		t.Fatalf("explicit false rejected: %v", err)
	}
}
