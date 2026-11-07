package query_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
)

func TestExpressionsAndEvidence(t *testing.T) {
	cases := []struct {
		expression, title, description    string
		matches, titleHit, descriptionHit bool
	}{
		{"cache", "CacheManager", "", true, true, false},
		{"i", "I", "", true, true, false},
		{"i", "İ", "", false, false, false},
		{"k", "K", "", false, false, false},
		{"é", "É", "", false, false, false},
		{"缓", "历史", "缓存 **修复**", true, false, true},
		{`"缓存 修复"`, "", "缓存 **修复**", false, false, false},
		{"%_*?", "", "literal %_*?", true, false, true},
		{"负责人 缓存", "负责人资料", "缓存", true, true, true},
		{"title:缓存", "其他", "缓存", false, false, false},
		{"description:缓存", "缓存", "其他", false, false, false},
		{"NOT description:缓存", "", "", true, false, false},
		{"NOT NOT 缓存", "缓存", "", true, true, false},
		{"NOT (A AND NOT B)", "B", "A", true, true, false},
		{"NOT (A AND NOT B)", "other", "", true, false, false},
		{"(title:缓存 AND description:数据库) OR description:登录", "缓存", "登录", true, false, true},
		{"A OR B AND C", "A", "", true, true, false},
		{"A OR B AND C", "B", "", false, false, false},
		{"and", "AND", "", true, true, false},
		{`"AND"`, "AND", "", true, true, false},
		{`"a\\\"b"`, `a\"b`, "", true, true, false},
		{`"https://example.com"`, "", "[link](https://example.com)", true, false, true},
		{"worker-pool", "Worker-pool", "", true, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.expression+"/"+tc.title+"/"+tc.description, func(t *testing.T) {
			root, err := query.Parse(tc.expression)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			e := query.Evaluate(root, tc.title, tc.description)
			if e.Matches != tc.matches || e.Title != tc.titleHit || e.Description != tc.descriptionHit {
				t.Fatalf("evidence = %+v, want matches/title/description %v/%v/%v", e, tc.matches, tc.titleHit, tc.descriptionHit)
			}
		})
	}
}

func TestSyntaxErrors(t *testing.T) {
	cases := []struct {
		input, reason    string
		position, length int
	}{
		{"  ", "empty_query", 1, 0},
		{"中文 AND", "expected_operand", 7, 0},
		{"😀 OR OR x", "expected_operand", 6, 2},
		{"中文 )", "unexpected_closing_group", 4, 1},
		{"中文 (x", "unclosed_group", 4, 1},
		{"私人文本 AND (", "unclosed_group", 10, 1},
		{"中文 \"x", "unclosed_quote", 4, 1},
		{"中文 \"\"", "empty_phrase", 4, 2},
		{`中文 "a\qb"`, "invalid_escape", 6, 2},
		{"中文 status:done", "unknown_field", 4, 6},
		{"title:", "missing_field_value", 7, 0},
		{"title:(x)", "field_group_not_supported", 7, 1},
		{"x:y", "unknown_field", 1, 1},
		{"x\"y\"", "unexpected_token", 2, 3},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			_, err := query.Parse(tc.input)
			var actual *query.Error
			if !errors.As(err, &actual) {
				t.Fatalf("got %v, want syntax error", err)
			}
			if actual.Reason != tc.reason || actual.Position != tc.position || actual.Length != tc.length {
				t.Fatalf("got %+v, want %s at %d length %d", actual, tc.reason, tc.position, tc.length)
			}
		})
	}
}

func TestLimits(t *testing.T) {
	valid := []string{
		strings.Repeat("a", 8192),
		strings.TrimSpace(strings.Repeat("a ", 128)),
		strings.Repeat("(", 32) + "x" + strings.Repeat(")", 32),
	}
	for _, s := range valid {
		if _, err := query.Parse(s); err != nil {
			t.Fatalf("boundary rejected: %v", err)
		}
	}
	invalid := []struct {
		input, reason string
		pos           int
	}{
		{strings.Repeat("a", 8192) + "b", "query_too_large", 8193},
		{strings.Repeat("a ", 128) + "b", "too_many_terms", 257},
		{strings.Repeat("(", 33) + "x" + strings.Repeat(")", 33), "nesting_too_deep", 33},
		{strings.Repeat("中", 2730) + "中", "query_too_large", 2731},
	}
	for _, tc := range invalid {
		_, err := query.Parse(tc.input)
		var e *query.Error
		if !errors.As(err, &e) || e.Reason != tc.reason || e.Position != tc.pos {
			t.Fatalf("got %v, want %s at %d", err, tc.reason, tc.pos)
		}
	}
}

func TestASTPositionsUseOriginalUnicodeInput(t *testing.T) {
	input := "😀 NOT (title:foo OR description:bar)"
	root, err := query.Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	if root.Position != 1 || root.Length != utf8.RuneCountInString(input) || root.Right.Position != 3 || root.Right.Length != utf8.RuneCountInString(input)-2 {
		t.Fatalf("unexpected source spans: root=%+v right=%+v", root, root.Right)
	}
	if root.Right.Kind != tasksearch.And || root.Right.Left.Position != 8 || root.Right.Right.Position != 21 {
		t.Fatalf("unexpected negated group spans: %+v %+v", root.Right.Left, root.Right.Right)
	}
}

func TestSnippetUsesFirstSuccessfulDescriptionBranch(t *testing.T) {
	root, err := query.Parse(`(title:missing AND description:first) OR description:second`)
	if err != nil {
		t.Fatal(err)
	}
	description := "first" + strings.Repeat("中", 100) + "SECOND" + strings.Repeat("文", 100)
	e := query.Evaluate(root, "other", description)
	snippet := query.Snippet(description, e)
	if snippet == nil || !strings.Contains(*snippet, "SECOND") || strings.Contains(*snippet, "first") || !strings.HasPrefix(*snippet, "…") || !strings.HasSuffix(*snippet, "…") {
		t.Fatalf("unexpected snippet %v", snippet)
	}
	if utf8.RuneCountInString(*snippet) != 162 {
		t.Fatalf("snippet length = %d", utf8.RuneCountInString(*snippet))
	}
	negative, err := query.Parse("NOT absent")
	if err != nil {
		t.Fatal(err)
	}
	if got := query.Snippet(description, query.Evaluate(negative, "", description)); got != nil {
		t.Fatalf("negative snippet = %q", *got)
	}
}

func TestContextCancellationAndWindowBoundary(t *testing.T) {
	root, err := query.Parse(`description:"缓存刷新"`)
	if err != nil {
		t.Fatal(err)
	}
	description := strings.Repeat("a", 65535) + "缓存刷新" + strings.Repeat("b", 65536)
	e, err := query.EvaluateContext(context.Background(), root, "", description)
	if err != nil || !e.Matches || !e.Description {
		t.Fatalf("boundary evidence: %+v, %v", e, err)
	}
	snippet, err := query.SnippetContext(context.Background(), description, e)
	if err != nil || snippet == nil || !strings.Contains(*snippet, "缓存刷新") {
		t.Fatalf("boundary snippet: %v, %v", snippet, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := query.EvaluateContext(ctx, root, "", description); !errors.Is(err, context.Canceled) {
		t.Fatalf("evaluation cancellation: %v", err)
	}
	if _, err := query.SnippetContext(ctx, description, e); !errors.Is(err, context.Canceled) {
		t.Fatalf("snippet cancellation: %v", err)
	}
}

type cancelAfterChecks struct {
	context.Context
	cancel context.CancelFunc
	checks int
	after  int
}

func (c *cancelAfterChecks) Err() error {
	c.checks++
	if c.checks == c.after {
		c.cancel()
	}
	return c.Context.Err()
}

func TestCancellationDuringSubstringScan(t *testing.T) {
	root, err := query.Parse("title:needle")
	if err != nil {
		t.Fatal(err)
	}
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The first window is scanned before cancellation at the next window.
	ctx := &cancelAfterChecks{Context: base, cancel: cancel, after: 8}
	_, err = query.EvaluateContext(ctx, root, strings.Repeat("a", 150000), "")
	if !errors.Is(err, context.Canceled) || ctx.checks != 8 {
		t.Fatalf("expected scan cancellation, got %v after %d checks", err, ctx.checks)
	}
}

func TestSyntaxErrorStringDoesNotExposeInput(t *testing.T) {
	_, err := query.Parse("private-search-text AND (")
	if err == nil || err.Error() != "invalid search expression: unclosed_group" {
		t.Fatalf("unexpected error: %v", err)
	}
}
