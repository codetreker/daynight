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
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
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
	resolveTags   func(context.Context, string, []string) ([]model.Tag, error)
	onMatches     func(context.Context, string, store.TaskSearchQuery)
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
func (f *searchFixture) ResolveTags(ctx context.Context, project string, ids []string) ([]model.Tag, error) {
	if f.resolveTags == nil {
		panic("unexpected ResolveTags")
	}
	return f.resolveTags(ctx, project, ids)
}
func (f *searchFixture) Matches(ctx context.Context, project string, query store.TaskSearchQuery) (store.TaskSearchPage, error) {
	if f.onMatches != nil {
		f.onMatches(ctx, project, query)
	}
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
	parent := root
	return &searchFixture{fence: store.TaskSearchFence{Epoch: user, Count: "2", VersionSum: "2"}, rows: store.TaskSearchPage{Total: 2, HasMore: true, Items: []store.TaskSearchRow{{ID: child, Type: model.TaskTypeTask, ParentID: &parent, Title: "Cache", Description: "raw markdown", Status: model.TaskDone, UpdatedAt: now, TitlePriority: true}}}, graph: store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: child, CreatedAt: now}, {ID: root, CreatedAt: now.Add(-time.Hour)}}, Edges: []store.TaskSearchEdge{{TaskID: child, DependsOnID: root}}}}
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
	for _, phase := range []string{"fence", "matches", "titles"} {
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
	scope := cursorScope{Version: 4, Type: model.TaskTypeTask, UserID: user, ProjectID: projectID, QueryHash: "hash"}
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
	scope := cursorScope{Version: 4, TagFilterIdentity: taskcore.TagFilterIdentity(store.TagFilter{TagIDs: []string{}, TagMatch: "all"}), Type: model.TaskTypeTask, UserID: user, ProjectID: projectID, QueryHash: fmt.Sprintf("%x", sha256.Sum256([]byte("id:"+id))), AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}}
	value, err := decodeCursor(*page.NextCursor, scope)
	if err != nil || !value.Position.ExactIDPriority || value.Position.TitlePriority || value.Position.ID != id {
		t.Fatalf("position=%+v err=%v", value.Position, err)
	}

}

func TestSearchCursorV4RequiresCanonicalExactPriority(t *testing.T) {
	scope := cursorScope{Version: 4, Type: model.TaskTypeTask, UserID: user, ProjectID: projectID, QueryHash: "hash"}
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
		"old version": strings.Replace(string(raw), `"version":4`, `"version":3`, 1),
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

func TestSearchContextUsesOnlyRealParentAndRejectsMissingParent(t *testing.T) {
	for _, tc := range []struct {
		name        string
		typ         model.TaskType
		parent      *string
		missing     bool
		wantContext bool
		wantError   bool
	}{
		{name: "child", typ: model.TaskTypeTask, parent: ptrSearch(root), wantContext: true},
		{name: "independent", typ: model.TaskTypeTask},
		{name: "goal", typ: model.TaskTypeGoal},
		{name: "invalid parent", typ: model.TaskTypeTask, parent: ptrSearch(root), missing: true, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := testFixture()
			f.rows.Items[0].Type, f.rows.Items[0].ParentID, f.missingTitles = tc.typ, tc.parent, tc.missing
			page, err := Search(context.Background(), f, principal(), projectID, Request{Query: "cache", Limit: 1})
			if tc.wantError {
				if err == nil {
					t.Fatal("missing parent accepted")
				}
				return
			}
			if err != nil || len(page.Items) != 1 || (page.Items[0].Context != nil) != tc.wantContext || f.graphCalled {
				t.Fatalf("context=%+v graph=%v error=%v", page, f.graphCalled, err)
			}
		})
	}
}

func TestSearchCursorBindsTypeAndParent(t *testing.T) {
	f := testFixture()
	request := Request{Query: "cache", Limit: 1}
	page, err := Search(context.Background(), f, principal(), projectID, request)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page=%+v error=%v", page, err)
	}
	for _, change := range []Request{
		{Query: "cache", Limit: 1, Cursor: page.NextCursor, Type: model.TaskTypeGoal},
		{Query: "cache", Limit: 1, Cursor: page.NextCursor, Parent: ptrSearch("none")},
		{Query: "cache", Limit: 1, Cursor: page.NextCursor, Parent: ptrSearch(root)},
	} {
		_, err := Search(context.Background(), f, principal(), projectID, change)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("scope change accepted: %+v %v", change, err)
		}
	}
}

func ptrSearch(value string) *string { return &value }

func TestSearchTagFilterQualificationAndCursor(t *testing.T) {
	const tagA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const tagB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	f := testFixture()
	ctx := t.Context()
	resolved := 0
	f.resolveTags = func(actual context.Context, project string, ids []string) ([]model.Tag, error) {
		resolved++
		if actual != ctx || project != projectID || !reflect.DeepEqual(ids, []string{tagA, tagB}) {
			t.Fatalf("tag qualification changed: %s %v", project, ids)
		}
		return []model.Tag{{ID: tagA}, {ID: tagB}}, nil
	}
	matched := 0
	f.onMatches = func(actual context.Context, project string, selection store.TaskSearchQuery) {
		matched++
		want := store.TagFilter{TagIDs: []string{tagA, tagB}, TagMatch: "any"}
		if actual != ctx || project != projectID || !reflect.DeepEqual(selection.TagFilter, want) || selection.Expression == nil || selection.Expression.Kind != searchmodel.Or {
			t.Fatalf("selection changed: %#v", selection)
		}
	}
	f.rows.Items[0].Tags = []model.TagReference{{ID: tagA, Name: "backend"}}
	req := Request{Query: "cache OR NOT title:other", Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{tagB, strings.ToUpper(tagA), tagA}, TagMatch: "any"}}
	page, err := Search(ctx, f, principal(), projectID, req)
	if err != nil || page.NextCursor == nil || !reflect.DeepEqual(page.Items[0].Tags, f.rows.Items[0].Tags) || resolved != 1 || matched != 1 {
		t.Fatalf("page=%#v resolved=%d matched=%d error=%v", page, resolved, matched, err)
	}
	req.Cursor = page.NextCursor
	req.TagFilter.TagIDs = []string{tagA, tagB}
	if _, err := Search(ctx, f, principal(), projectID, req); err != nil || resolved != 2 || matched != 2 {
		t.Fatalf("canonical continuation failed: %v", err)
	}
	for _, filter := range []store.TagFilter{
		{TagIDs: []string{tagA}, TagMatch: "any"},
		{TagIDs: []string{tagA, tagB}, TagMatch: "all"},
		{Untagged: true},
	} {
		req.TagFilter = filter
		_, err := Search(ctx, f, principal(), projectID, req)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("changed filter accepted: %#v %v", filter, err)
		}
	}
	if resolved != 2 || matched != 2 {
		t.Fatal("mismatched cursor reached snapshot")
	}
}

func TestSearchTagFilterRefusesInvalidOrChangedInputs(t *testing.T) {
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, filter := range []store.TagFilter{
		{TagIDs: []string{"bad"}}, {TagMatch: "invalid"}, {TagIDs: []string{tagID}, Untagged: true},
	} {
		_, err := Search(t.Context(), testFixture(), principal(), projectID, Request{Query: "cache", Limit: 1, TagFilter: filter})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_tag_filter" {
			t.Fatalf("filter %#v: %v", filter, err)
		}
	}
	f := testFixture()
	resolved := 0
	f.resolveTags = func(context.Context, string, []string) ([]model.Tag, error) {
		resolved++
		return nil, nil
	}
	f.onMatches = func(context.Context, string, store.TaskSearchQuery) { t.Fatal("invalid tag reached selection") }
	req := Request{Query: "cache", Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{tagID}}}
	_, err := Search(t.Context(), f, principal(), projectID, req)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_tag_filter" || resolved != 1 {
		t.Fatalf("missing tag: %v", err)
	}
	f.denied = true
	_, err = Search(t.Context(), f, principal(), projectID, req)
	if err == nil || resolved != 1 {
		t.Fatalf("qualification occurred before permission: %v", err)
	}
	f.denied = false
	f.resolveTags = func(context.Context, string, []string) ([]model.Tag, error) { return []model.Tag{{ID: tagID}}, nil }
	f.onMatches = nil
	page, err := Search(t.Context(), f, principal(), projectID, req)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("first page: %#v %v", page, err)
	}
	req.Cursor = page.NextCursor
	f.fence.VersionSum = "3"
	f.resolveTags = func(context.Context, string, []string) ([]model.Tag, error) {
		t.Fatal("changed fence must precede tag qualification")
		return nil, nil
	}
	_, err = Search(t.Context(), f, principal(), projectID, req)
	if !errors.As(err, &fault) || fault.Code != "search_changed" {
		t.Fatalf("changed snapshot not reported: %v", err)
	}
}

func TestSearchTagFilterPreservesOtherQualificationsAndErrors(t *testing.T) {
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	f := testFixture()
	status := model.TaskTodo
	ready := true
	parent := root
	f.onMatches = func(_ context.Context, _ string, selection store.TaskSearchQuery) {
		if !selection.TagFilter.Untagged || selection.TagFilter.TagMatch != "all" || selection.Type != model.TaskTypeTask || selection.Parent == nil || *selection.Parent != parent || selection.Status != &status || selection.Ready != &ready {
			t.Fatalf("selection lost qualifications: %#v", selection)
		}
	}
	_, err := Search(t.Context(), f, principal(), projectID, Request{Query: "cache AND NOT missing", Limit: 1, Type: model.TaskTypeTask, Parent: &parent, Status: &status, Ready: &ready, TagFilter: store.TagFilter{Untagged: true}})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("tag read failed")
	f.resolveTags = func(context.Context, string, []string) ([]model.Tag, error) { return nil, sentinel }
	f.onMatches = func(context.Context, string, store.TaskSearchQuery) {
		t.Fatal("failed tag qualification reached selection")
	}
	page, err := Search(t.Context(), f, principal(), projectID, Request{Query: "cache", Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{tagID}}})
	if !errors.Is(err, sentinel) || !reflect.DeepEqual(page, Page{}) {
		t.Fatalf("tag read error lost: %#v %v", page, err)
	}
	f.resolveTags = func(context.Context, string, []string) ([]model.Tag, error) { return nil, context.Canceled }
	page, err = Search(t.Context(), f, principal(), projectID, Request{Query: "cache", Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{tagID}}})
	if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(page, Page{}) {
		t.Fatalf("tag read cancellation lost: %#v %v", page, err)
	}
}
