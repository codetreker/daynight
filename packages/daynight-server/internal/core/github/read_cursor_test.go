package github

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

func encodedJSON(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func TestCursorStrictDecoding(t *testing.T) {
	r := ListRequest{State: "active", Query: "中文", Limit: 2}
	valid := `{"v":1,"projectId":"` + projectID + `","state":"active","q":"中文","limit":2,"upperNumber":"12","anchorNumber":"10","direction":"next"}`
	if c, err := decodeCursor(encodedJSON(valid), projectID, r); err != nil || c.upper != 12 || c.anchor != 10 || c.direction != "next" {
		t.Fatalf("valid cursor %+v %v", c, err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"v":1`, `"v":2`, 1),
		strings.Replace(valid, projectID, "44444444-4444-4444-8444-444444444444", 1),
		strings.Replace(valid, `"active"`, `"closed"`, 1),
		strings.Replace(valid, `"中文"`, `"other"`, 1),
		strings.Replace(valid, `"limit":2`, `"limit":3`, 1),
		strings.Replace(valid, `"upperNumber":"12"`, `"upperNumber":"012"`, 1),
		strings.Replace(valid, `"upperNumber":"12"`, `"upperNumber":"9223372036854775808"`, 1),
		strings.Replace(valid, `"anchorNumber":"10"`, `"anchorNumber":"0"`, 1),
		strings.Replace(valid, `"anchorNumber":"10"`, `"anchorNumber":"14"`, 1),
		strings.Replace(valid, `"direction":"next"`, `"direction":"sideways"`, 1),
		strings.Replace(valid, `"v":1`, `"v":1,"v":1`, 1),
		strings.Replace(valid, `"v":1`, `"extra":1`, 1),
		strings.Replace(valid, `"projectId"`, `"ProjectId"`, 1),
		strings.Replace(valid, `,"limit":2`, ``, 1), valid + ` {}`,
	} {
		_, err := decodeCursor(encodedJSON(raw), projectID, r)
		if err == nil {
			t.Fatalf("accepted invalid cursor %s", raw)
		}
		faultCode(t, err, "invalid_input")
	}
	emptyQuery := ListRequest{State: "active", Limit: 2}
	nullQuery := strings.Replace(valid, `"q":"中文"`, `"q":null`, 1)
	_, err := decodeCursor(encodedJSON(nullQuery), projectID, emptyQuery)
	faultCode(t, err, "invalid_input")
	invalidSurrogate := strings.Replace(valid, `"q":"中文"`, `"q":"\ud800"`, 1)
	if _, err := decodeCursor(encodedJSON(invalidSurrogate), projectID, ListRequest{State: "active", Query: "�", Limit: 2}); err == nil {
		t.Fatal("accepted lone surrogate")
	}
	invalidUTF8 := strings.Replace(valid, `"q":"中文"`, "\"q\":\"\xff\"", 1)
	_, err = decodeCursor(encodedJSON(invalidUTF8), projectID, ListRequest{State: "active", Query: "�", Limit: 2})
	faultCode(t, err, "invalid_input")
	for _, encoded := range []string{encodedJSON(valid) + "=", "!!!", strings.Repeat("a", transport.MaxEncodedCursorBytes+1)} {
		_, err := decodeCursor(encoded, projectID, r)
		faultCode(t, err, "invalid_input")
	}
}

func TestCursorVersionsAndAuthorScope(t *testing.T) {
	author := int64(9007199254740997)
	other := author + 1
	request := ListRequest{State: "active", Query: "中文", Limit: 2, AuthorID: &author}
	legacyRequest := ListRequest{State: request.State, Query: request.Query, Limit: request.Limit}
	legacyJSON := `{"v":1,"projectId":"` + projectID + `","state":"active","q":"中文","limit":2,"upperNumber":"12","anchorNumber":"10","direction":"next"}`
	v2JSON := strings.Replace(legacyJSON, `"v":1`, `"v":2`, 1)
	v2JSON = strings.TrimSuffix(v2JSON, "}") + `,"authorId":"9007199254740997"}`

	// Captured by running read_cursor.go and firstPageCursor from baseline
	// a1741fe6a2284c295a48435ea62d6ed6cc02ea52 with these inputs.
	const oldGoCursor = "eyJ2IjoxLCJwcm9qZWN0SWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzdGF0ZSI6ImFjdGl2ZSIsInEiOiLkuK3mlociLCJsaW1pdCI6MiwidXBwZXJOdW1iZXIiOiIxMiIsImFuY2hvck51bWJlciI6IjEwIiwiZGlyZWN0aW9uIjoibmV4dCJ9"
	const oldWebCursor = "eyJ2IjoxLCJwcm9qZWN0SWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzdGF0ZSI6ImFjdGl2ZSIsInEiOiIiLCJsaW1pdCI6NiwidXBwZXJOdW1iZXIiOiI0MiIsImFuY2hvck51bWJlciI6IjQzIiwiZGlyZWN0aW9uIjoibmV4dCJ9"
	if got := *encodeCursor(projectID, legacyRequest, 12, 10, "next"); got != oldGoCursor {
		t.Fatalf("v1 encoding changed: %s", got)
	}
	if cursor, err := decodeCursor(oldGoCursor, projectID, legacyRequest); err != nil || cursor.upper != 12 || cursor.anchor != 10 {
		t.Fatalf("baseline Go cursor: %+v %v", cursor, err)
	}
	webRequest := ListRequest{State: "active", Limit: 6}
	if cursor, err := decodeCursor(oldWebCursor, projectID, webRequest); err != nil || cursor.upper != 42 || cursor.anchor != 43 {
		t.Fatalf("old Web cursor: %+v %v", cursor, err)
	}
	if got := *encodeCursor(projectID, request, 12, 10, "next"); got != encodedJSON(v2JSON) {
		t.Fatalf("v2 encoding: %s", got)
	}
	if cursor, err := decodeCursor(encodedJSON(v2JSON), projectID, request); err != nil || cursor.upper != 12 || cursor.anchor != 10 {
		t.Fatalf("v2 decoding: %+v %v", cursor, err)
	}
	maxID := int64(9223372036854775807)
	maxRequest := ListRequest{State: "all", Limit: 1, AuthorID: &maxID}
	maxEncoded := *encodeCursor(projectID, maxRequest, maxID, 0, "previous")
	if cursor, err := decodeCursor(maxEncoded, projectID, maxRequest); err != nil || cursor.upper != maxID || cursor.anchor != 0 {
		t.Fatalf("maximum number and previous anchor: %+v %v", cursor, err)
	}
	for _, tc := range []struct {
		name    string
		raw     string
		request ListRequest
	}{
		{"v1 with author request", legacyJSON, request},
		{"v2 without author request", v2JSON, legacyRequest},
		{"wrong author request", v2JSON, ListRequest{State: "active", Query: "中文", Limit: 2, AuthorID: &other}},
		{"v2 wrong query", v2JSON, ListRequest{State: "active", Query: "other", Limit: 2, AuthorID: &author}},
		{"v2 wrong state", v2JSON, ListRequest{State: "closed", Query: "中文", Limit: 2, AuthorID: &author}},
		{"v2 wrong limit", v2JSON, ListRequest{State: "active", Query: "中文", Limit: 3, AuthorID: &author}},
		{"v2 wrong project", strings.Replace(v2JSON, projectID, "44444444-4444-4444-8444-444444444444", 1), request},
		{"v2 wrong direction", strings.Replace(v2JSON, `"direction":"next"`, `"direction":"sideways"`, 1), request},
		{"v2 anchor beyond synthetic first page", strings.Replace(v2JSON, `"anchorNumber":"10"`, `"anchorNumber":"14"`, 1), request},
		{"missing author", strings.Replace(v2JSON, `,"authorId":"9007199254740997"`, "", 1), request},
		{"null author", strings.Replace(v2JSON, `"authorId":"9007199254740997"`, `"authorId":null`, 1), request},
		{"numeric author", strings.Replace(v2JSON, `"authorId":"9007199254740997"`, `"authorId":9007199254740997`, 1), request},
		{"leading zero", strings.Replace(v2JSON, `9007199254740997`, `09007199254740997`, 1), request},
		{"overflow", strings.Replace(v2JSON, `9007199254740997`, `9223372036854775808`, 1), request},
		{"zero", strings.Replace(v2JSON, `9007199254740997`, `0`, 1), request},
		{"duplicate author", strings.Replace(v2JSON, `"authorId":"9007199254740997"`, `"authorId":"9007199254740997","authorId":"9007199254740997"`, 1), request},
		{"unknown field", strings.Replace(v2JSON, `"authorId":`, `"extra":1,"authorId":`, 1), request},
		{"v1 with author field", strings.Replace(v2JSON, `"v":2`, `"v":1`, 1), legacyRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodeCursor(encodedJSON(tc.raw), projectID, tc.request)
			faultCode(t, err, "invalid_input")
		})
	}
}

func TestAuthorCursorChangedEmptyPage(t *testing.T) {
	ctx := context.Background()
	author := int64(9007199254740997)
	upper := int64(12)
	for _, tc := range []struct {
		name, direction, wantDirection string
		anchor, wantAnchor             int64
		previous                       bool
	}{
		{"next page emptied", "next", "previous", 10, 9, false},
		{"previous page emptied", "previous", "next", 8, 9, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := ListRequest{State: "active", Limit: 2, AuthorID: &author}
			request.Cursor = *encodeCursor(projectID, request, upper, tc.anchor, tc.direction)
			f := fixtureFor(ctx)
			f.page = store.GitHubPRPage{UpperNumber: &upper}
			page, err := NewReader(f, true).List(ctx, principal, projectID, request)
			if err != nil || f.query.AuthorID == nil || *f.query.AuthorID != author || f.query.Previous != tc.previous {
				t.Fatalf("author query %+v: %v", f.query, err)
			}
			var returnCursor *string
			if tc.previous {
				returnCursor = page.NextCursor
			} else {
				returnCursor = page.PreviousCursor
			}
			if returnCursor == nil {
				t.Fatal("missing return cursor")
			}
			cursor, err := decodeCursor(*returnCursor, projectID, request)
			if err != nil || cursor.upper != upper || cursor.anchor != tc.wantAnchor || cursor.direction != tc.wantDirection {
				t.Fatalf("return cursor %+v: %v", cursor, err)
			}
			other := author + 1
			request.AuthorID = &other
			if _, err := decodeCursor(*returnCursor, projectID, request); err == nil {
				t.Fatal("return cursor accepted a different author")
			}
		})
	}
}

func TestListCursorTraversalAndChangedEmptyPage(t *testing.T) {
	ctx := context.Background()
	req := ListRequest{State: "active", Limit: 2}
	type expected struct {
		upper, anchor int64
		direction     string
	}
	decode := func(cursor *string, want expected) {
		t.Helper()
		if cursor == nil {
			t.Fatalf("missing cursor: %+v", want)
		}
		c, err := decodeCursor(*cursor, projectID, req)
		if err != nil || c.upper != want.upper || c.anchor != want.anchor || c.direction != want.direction {
			t.Fatalf("cursor %+v %v, want %+v", c, err, want)
		}
	}
	makePage := func(nums ...int64) []githubpr.PullRequestSummary {
		items := make([]githubpr.PullRequestSummary, 0, len(nums))
		for _, n := range nums {
			items = append(items, githubpr.PullRequestSummary{Number: n})
		}
		return items
	}
	upper := int64(12)
	f := fixtureFor(ctx)
	f.page = store.GitHubPRPage{Items: makePage(12, 10), Total: 5, UpperNumber: &upper, HasMore: true}
	page, err := NewReader(f, true).List(ctx, principal, projectID, req)
	if err != nil || page.PreviousCursor != nil {
		t.Fatalf("first page %+v %v", page, err)
	}
	decode(page.NextCursor, expected{12, 10, "next"})
	req.Cursor = *page.NextCursor
	f = fixtureFor(ctx)
	f.page = store.GitHubPRPage{Items: makePage(8, 6), Total: 5, UpperNumber: &upper, HasMore: true}
	page, err = NewReader(f, true).List(ctx, principal, projectID, req)
	if err != nil || f.query.Previous || f.query.AnchorNumber == nil || *f.query.AnchorNumber != 10 || f.query.UpperNumber == nil || *f.query.UpperNumber != 12 {
		t.Fatalf("second page %+v query %+v %v", page, f.query, err)
	}
	decode(page.NextCursor, expected{12, 6, "next"})
	decode(page.PreviousCursor, expected{12, 8, "previous"})
	req.Cursor = *page.PreviousCursor
	f = fixtureFor(ctx)
	f.page = store.GitHubPRPage{Items: makePage(12, 10), UpperNumber: &upper}
	page, err = NewReader(f, true).List(ctx, principal, projectID, req)
	if err != nil || !f.query.Previous || page.PreviousCursor != nil {
		t.Fatalf("back page %+v query %+v %v", page, f.query, err)
	}
	decode(page.NextCursor, expected{12, 10, "next"})
	req.Cursor = *page.NextCursor
	f = fixtureFor(ctx)
	f.page = store.GitHubPRPage{UpperNumber: &upper}
	page, err = NewReader(f, true).List(ctx, principal, projectID, req)
	if err != nil || page.Items == nil || page.NextCursor != nil {
		t.Fatalf("changed empty page %+v %v", page, err)
	}
	decode(page.PreviousCursor, expected{12, 9, "previous"})
	// The previous cursor includes the formerly visible anchor, if it survives.
	req.Cursor = *page.PreviousCursor
	f = fixtureFor(ctx)
	f.page = store.GitHubPRPage{Items: makePage(12, 10), UpperNumber: &upper}
	page, err = NewReader(f, true).List(ctx, principal, projectID, req)
	if err != nil || !f.query.Previous || *f.query.AnchorNumber != 9 {
		t.Fatal(fmt.Sprintf("empty recovery %+v %+v %v", page, f.query, err))
	}
}
