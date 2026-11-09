package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
)

func captureSearchFixture(t *testing.T, name string, body []byte) {
	t.Helper()
	if dir := os.Getenv("DAYNIGHT_SEARCH_FIXTURE_CAPTURE"); dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".json"), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTaskSearchHTTPContract(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	path := taskCollection(testProjectID) + "/search"
	firstID := "55555555-5555-4555-8555-555555555555"
	secondID := "66666666-6666-4666-8666-666666666666"
	cursor := "private-continuation"
	snippet := "raw **cache** markdown"
	calls := 0
	h.ExpectCalls("Search", 3)
	h.Search = func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if principal != h.principal || projectID != testProjectID || ctx.Err() != nil {
			t.Fatalf("search identity=%+v project=%s", principal, projectID)
		}
		switch calls {
		case 1:
			if input.Query != "cache" || input.Limit != 1 || input.Cursor != nil {
				t.Fatalf("first input=%+v", input)
			}
			return tasksearch.Page{ProjectID: projectID, Total: 2, NodeCount: 3, Items: []tasksearch.Item{{ID: firstID, ProjectID: projectID, Title: "Cache title", Status: model.TaskTodo, UpdatedAt: testTime, Context: &tasksearch.Context{TaskID: testTaskID, Title: "Goal"}, Match: tasksearch.Match{Fields: []string{"title"}}}}, NextCursor: &cursor}, nil
		case 2:
			if input.Query != "cache" || input.Limit != 1 || input.Cursor == nil || *input.Cursor != cursor {
				t.Fatalf("continuation=%+v", input)
			}
			return tasksearch.Page{ProjectID: projectID, Total: 2, NodeCount: 3, Items: []tasksearch.Item{{ID: secondID, ProjectID: projectID, Title: "Other", Status: model.TaskTodo, UpdatedAt: testTime, Match: tasksearch.Match{Fields: []string{"description"}, DescriptionSnippet: &snippet}}}}, nil
		default:
			if input.Query != "no-such-term" || input.Limit != 50 {
				t.Fatalf("empty input=%+v", input)
			}
			return tasksearch.Page{ProjectID: projectID, Items: []tasksearch.Item{}}, nil
		}
	}
	response := projectRequest(h, http.MethodPost, path, `{"query":"cache","limit":1}`)
	page := decodeResponse[api.TaskSearchPage](t, response, 200)
	captureSearchFixture(t, "first-page", response.Body.Bytes())
	if page.ProjectID != testProjectID || page.Total != 2 || len(page.Items) != 1 || page.Items[0].ID != firstID || page.NextCursor == nil || *page.NextCursor != cursor || page.Items[0].Context == nil || page.Items[0].Context.TaskID != testTaskID {
		t.Fatalf("first=%+v", page)
	}
	response = projectRequest(h, http.MethodPost, path, jsonBody(t, map[string]any{"query": "cache", "limit": 1, "cursor": *page.NextCursor}))
	next := decodeResponse[api.TaskSearchPage](t, response, 200)
	captureSearchFixture(t, "next-page", response.Body.Bytes())
	if next.Total != 2 || len(next.Items) != 1 || next.Items[0].ID != secondID || next.NextCursor != nil || next.Items[0].Match.DescriptionSnippet == nil || *next.Items[0].Match.DescriptionSnippet != snippet {
		t.Fatalf("next=%+v", next)
	}
	response = projectRequest(h, http.MethodPost, path, `{"query":"no-such-term"}`)
	empty := decodeResponse[api.TaskSearchPage](t, response, 200)
	captureSearchFixture(t, "empty-page", response.Body.Bytes())
	if empty.Items == nil || empty.Total != 0 || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty=%+v", empty)
	}
	response = projectRequest(h, http.MethodPost, path, `{"query":"cache","limit":0}`)
	assertProjectError(t, response, 400, "invalid_input")
	captureSearchFixture(t, "invalid-input", response.Body.Bytes())
	if calls != 3 {
		t.Fatalf("protocol refusal invoked search: %d", calls)
	}
	cases := []struct {
		input, reason    string
		position, length int
	}{
		{"缓存 AND (", "unclosed_group", 8, 1}, {"  ", "empty_query", 1, 0}, {"中文 AND", "expected_operand", 7, 0},
		{`x"y"`, "unexpected_token", 2, 3}, {"中文 )", "unexpected_closing_group", 4, 1}, {"中文 (x", "unclosed_group", 4, 1}, {`中文 "x`, "unclosed_quote", 4, 1},
		{`中文 ""`, "empty_phrase", 4, 2}, {`中文 "a\qb"`, "invalid_escape", 6, 2}, {"中文 status:done", "unknown_field", 4, 6}, {"title:", "missing_field_value", 7, 0}, {"title:(x)", "field_group_not_supported", 7, 1},
		{strings.Repeat("a", 8193), "query_too_large", 8193, 1}, {strings.Repeat("a ", 128) + "b", "too_many_terms", 257, 1}, {strings.Repeat("(", 33) + "x" + strings.Repeat(")", 33), "nesting_too_deep", 33, 1},
	}
	for index, tc := range cases {
		t.Run(tc.reason, func(t *testing.T) {
			fixture := newHTTPFixture(t, io.Discard)
			fixture.Search = func(ctx context.Context, principal model.Principal, pid string, input tasksearch.Request) (tasksearch.Page, error) {
				if input.Query != tc.input {
					t.Fatalf("query changed: %q", input.Query)
				}
				return tasksearch.Page{}, &model.Fault{Code: "invalid_search_expression", Message: "Search expression is invalid.", SearchExpression: &model.SearchExpressionDetails{Reason: tc.reason, Position: tc.position, Length: tc.length}}
			}
			response := projectRequest(fixture, http.MethodPost, path, jsonBody(t, map[string]any{"query": tc.input}))
			assertProjectError(t, response, 400, "invalid_search_expression")
			var result api.ErrorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			details := result.Error.Details
			if details == nil || details.Reason == nil || *details.Reason != tc.reason || details.Position == nil || *details.Position != tc.position || details.Length == nil || *details.Length != tc.length {
				t.Fatalf("syntax=%s", response.Body)
			}
			name := "syntax-" + tc.reason
			if index == 0 {
				name = "invalid-expression"
			}
			captureSearchFixture(t, name, response.Body.Bytes())
			if index == 0 {
				return
			}
			bytes, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "task-search", "syntax-"+tc.reason+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var saved api.ErrorResponse
			if err := json.Unmarshal(bytes, &saved); err != nil {
				t.Fatal(err)
			}
			sd := saved.Error.Details
			if saved.Error.Code != result.Error.Code || sd == nil || sd.Reason == nil || *sd.Reason != tc.reason || sd.Position == nil || *sd.Position != tc.position || sd.Length == nil || *sd.Length != tc.length {
				t.Fatalf("saved fixture %s differs", tc.reason)
			}
		})
	}
	changed := newHTTPFixture(t, io.Discard)
	changed.Search = func(ctx context.Context, p model.Principal, pid string, input tasksearch.Request) (tasksearch.Page, error) {
		if input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("cursor=%+v", input)
		}
		return tasksearch.Page{}, &model.Fault{Code: "search_changed", Message: "Search changed."}
	}
	response = projectRequest(changed, http.MethodPost, path, jsonBody(t, map[string]any{"query": "cache", "limit": 1, "cursor": cursor}))
	assertProjectError(t, response, 409, "search_changed")
	captureSearchFixture(t, "search-changed", response.Body.Bytes())
	if strings.Contains(response.Body.String(), cursor) {
		t.Fatal("cursor leaked")
	}
}

func TestSearchHTTPEncodesBoundedPagesAndCursor(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	cursor := "second-page"
	calls := 0
	large := "match" + strings.Repeat("\x01", 180000)
	ids := []string{testTaskID, "55555555-5555-4555-8555-555555555555"}
	h.ExpectCalls("Search", 3)
	h.Search = func(ctx context.Context, p model.Principal, pid string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if input.Query != "match" || input.Limit != 2 {
			t.Fatalf("input=%+v", input)
		}
		if calls == 3 {
			return tasksearch.Page{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Search response exceeds its resource limit."}
		}
		if (calls == 1 && input.Cursor != nil) || (calls == 2 && (input.Cursor == nil || *input.Cursor != cursor)) {
			t.Fatalf("cursor input=%+v", input)
		}
		page := tasksearch.Page{ProjectID: pid, Total: 2, Items: []tasksearch.Item{{ID: ids[calls-1], ProjectID: pid, Title: large, Status: model.TaskTodo, UpdatedAt: testTime, Match: tasksearch.Match{Fields: []string{"title"}}}}}
		if calls == 1 {
			page.NextCursor = &cursor
		}
		return page, nil
	}
	path := taskCollection(testProjectID) + "/search"
	response := projectRequest(h, http.MethodPost, path, `{"query":"match","limit":2}`)
	first := decodeResponse[api.TaskSearchPage](t, response, 200)
	if response.Body.Len() > 2<<20 || len(first.Items) != 1 || first.Items[0].ID != ids[0] || first.NextCursor == nil {
		t.Fatalf("first size=%d page=%+v", response.Body.Len(), first)
	}
	response = projectRequest(h, http.MethodPost, path, jsonBody(t, map[string]any{"query": "match", "limit": 2, "cursor": *first.NextCursor}))
	next := decodeResponse[api.TaskSearchPage](t, response, 200)
	if response.Body.Len() > 2<<20 || len(next.Items) != 1 || next.Items[0].ID != ids[1] || next.NextCursor != nil {
		t.Fatalf("next size=%d page=%+v", response.Body.Len(), next)
	}
	assertProjectError(t, projectRequest(h, http.MethodPost, path, `{"query":"match","limit":2}`), 409, "resource_limit_exceeded")
}
