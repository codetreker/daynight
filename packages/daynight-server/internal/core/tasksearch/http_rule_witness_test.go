package tasksearch

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type httpRuleSearchFixture struct {
	*searchFixture
	t      *testing.T
	ctx    context.Context
	after  *store.TaskSearchPosition
	limit  int
	expect []string
	calls  []string
	finish func(error) error
}

func newHTTPRuleSearchFixture(t *testing.T, calls ...string) *httpRuleSearchFixture {
	t.Helper()
	f := &httpRuleSearchFixture{searchFixture: testFixture(), t: t, ctx: t.Context(), limit: 1, expect: calls}
	t.Cleanup(func() {
		if !slices.Equal(f.calls, f.expect) {
			t.Errorf("search calls=%v want%v", f.calls, f.expect)
		}
	})
	return f
}

func (f *httpRuleSearchFixture) called(ctx context.Context, project, method string) {
	f.t.Helper()
	if ctx != f.ctx || project != projectID || len(f.calls) >= len(f.expect) || f.expect[len(f.calls)] != method {
		f.t.Fatalf("unexpected search call %s for project %s after %v", method, project, f.calls)
	}
	f.calls = append(f.calls, method)
}

func (f *httpRuleSearchFixture) ReadTaskSearch(ctx context.Context, read func(store.TaskSearchSnapshot) error) error {
	f.called(ctx, projectID, "snapshot")
	if read == nil {
		f.t.Fatal("search omitted its snapshot callback")
	}
	err := read(f)
	if f.finish != nil {
		return f.finish(err)
	}
	if err != nil {
		return err
	}
	return f.completion
}

func (f *httpRuleSearchFixture) ProjectAccess(ctx context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
	f.called(ctx, project, "access")
	if actor != principal() {
		f.t.Fatal("search changed the authenticated principal")
	}
	return f.searchFixture.ProjectAccess(ctx, actor, project)
}

func (f *httpRuleSearchFixture) Fence(ctx context.Context, project string) (store.TaskSearchFence, error) {
	f.called(ctx, project, "fence")
	return f.searchFixture.Fence(ctx, project)
}

func (f *httpRuleSearchFixture) Matches(ctx context.Context, project string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	f.called(ctx, project, "matches")
	if input.Expression == nil || input.Expression.Kind != searchmodel.Leaf || input.Expression.Atom != (searchmodel.Atom{Term: "cache"}) || input.Expression.Negated ||
		input.AssignedTo != (model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}) || input.Status != nil || input.Ready != nil || input.AllowAgents != nil || input.CompatiblePlatform != nil || input.Limit != f.limit || !reflect.DeepEqual(input.After, f.after) {
		f.t.Fatalf("search changed its expression, filters, limit or continuation: %#v", input)
	}
	return f.searchFixture.Matches(ctx, project, input)
}

func (f *httpRuleSearchFixture) ContextGraph(ctx context.Context, project string, ids []string) (store.TaskSearchGraph, error) {
	f.called(ctx, project, "graph")
	if !slices.Equal(ids, []string{f.rows.Items[0].ID}) {
		f.t.Fatalf("context projected a different matching task: %v", ids)
	}
	return f.searchFixture.ContextGraph(ctx, project, ids)
}

func (f *httpRuleSearchFixture) Titles(ctx context.Context, project string, ids []string) (map[string]string, error) {
	f.called(ctx, project, "titles")
	if !slices.Equal(ids, []string{root}) {
		f.t.Fatalf("search requested unrelated context titles: %v", ids)
	}
	return f.searchFixture.Titles(ctx, project, ids)
}

func TestSearchPreservesRankingSnippetAndContinuation(t *testing.T) {
	f := newHTTPRuleSearchFixture(t, "snapshot", "access", "fence", "matches", "titles")
	f.rows.Items[0].Description = "Description without matching text"
	first, err := Search(f.ctx, f, principal(), projectID, Request{Query: "cache", Limit: 1})
	if err != nil || first.ProjectID != projectID || first.Total != 2 || len(first.Items) != 1 || first.Items[0].ID != child || first.NextCursor == nil ||
		!reflect.DeepEqual(first.Items[0].Context, &Context{TaskID: root, Title: "Goal"}) || !slices.Equal(first.Items[0].Match.Fields, []string{"title"}) || first.Items[0].Match.DescriptionSnippet != nil {
		t.Fatalf("title-ranked search: %#v %v", first, err)
	}

	secondID := "55555555-5555-4555-8555-555555555555"
	snippet := "raw **cache** markdown"
	next := newHTTPRuleSearchFixture(t, "snapshot", "access", "fence", "matches")
	next.after = &store.TaskSearchPosition{TitlePriority: true, UpdatedAt: f.rows.Items[0].UpdatedAt, ID: child}
	next.rows = store.TaskSearchPage{Total: 2, Items: []store.TaskSearchRow{{ID: secondID, Title: "Other", Status: model.TaskDone, UpdatedAt: f.rows.Items[0].UpdatedAt.Add(-time.Second),
		Description: snippet}}}
	next.graph = store.TaskSearchGraph{Nodes: []store.TaskSearchNode{{ID: secondID}}}
	page, err := Search(next.ctx, next, principal(), projectID, Request{Query: "cache", Limit: 1, Cursor: first.NextCursor})
	if err != nil || page.Total != 2 || len(page.Items) != 1 || page.Items[0].ID != secondID || page.NextCursor != nil || page.Items[0].Context != nil ||
		!slices.Equal(page.Items[0].Match.Fields, []string{"description"}) || page.Items[0].Match.DescriptionSnippet == nil || *page.Items[0].Match.DescriptionSnippet != snippet {
		t.Fatalf("description continuation lost description evidence: %#v %v", page, err)
	}
}

func TestSearchCompletionFailurePrecedesLateCallerCancellation(t *testing.T) {
	for _, phase := range []string{"commit", "cleanup", "caller cancellation"} {
		t.Run(phase, func(t *testing.T) {
			f := newHTTPRuleSearchFixture(t, "snapshot", "access", "fence", "matches", "titles")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			f.ctx = ctx
			cause := errors.New("snapshot completion sentinel")
			failure := &store.TransactionError{Phase: phase, Outcome: store.TransactionUnknown, CommitAttempted: phase == "commit", CleanupFailed: phase == "cleanup", Cause: errors.Join(context.Canceled, cause)}
			f.finish = func(err error) error {
				if err != nil {
					t.Fatalf("search did not complete its accepted page before cancellation: %v", err)
				}
				cancel()
				if phase == "caller cancellation" {
					return nil
				}
				return failure
			}
			page, err := Search(ctx, f, principal(), projectID, Request{Query: "cache", Limit: 1})
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(page, Page{}) {
				t.Fatalf("late cancellation returned an accepted page or lost its cause: %#v %v", page, err)
			}
			if phase != "caller cancellation" && (err != failure || !errors.Is(err, cause)) {
				t.Fatalf("caller cancellation replaced snapshot completion facts: %#v", err)
			}
		})
	}
}

func TestSearchSyntaxDetailsAreRejectedBeforeSnapshot(t *testing.T) {
	for _, test := range []struct {
		input, reason    string
		position, length int
	}{
		{"  ", "empty_query", 1, 0}, {"中文 AND", "expected_operand", 7, 0},
		{`x"y"`, "unexpected_token", 2, 3}, {"中文 )", "unexpected_closing_group", 4, 1},
		{"中文 (x", "unclosed_group", 4, 1}, {`中文 "x`, "unclosed_quote", 4, 1},
		{`中文 ""`, "empty_phrase", 4, 2}, {`中文 "a\qb"`, "invalid_escape", 6, 2},
		{"中文 status:done", "unknown_field", 4, 6}, {"title:", "missing_field_value", 7, 0},
		{"title:(x)", "field_group_not_supported", 7, 1},
		{strings.Repeat("a", 8193), "query_too_large", 8193, 1},
		{strings.Repeat("a ", 128) + "b", "too_many_terms", 257, 1},
		{strings.Repeat("(", 33) + "x" + strings.Repeat(")", 33), "nesting_too_deep", 33, 1},
	} {
		t.Run(test.reason, func(t *testing.T) {
			f := newHTTPRuleSearchFixture(t)
			page, err := Search(f.ctx, f, principal(), projectID, Request{Query: test.input, Limit: 1})
			var fault *model.Fault
			want := &model.SearchExpressionDetails{Reason: test.reason, Position: test.position, Length: test.length}
			if !errors.As(err, &fault) || fault.Code != "invalid_search_expression" || !reflect.DeepEqual(fault.SearchExpression, want) || !reflect.DeepEqual(page, Page{}) {
				t.Fatalf("syntax details changed: page=%#v fault=%#v err=%v", page, fault, err)
			}
		})
	}
}
