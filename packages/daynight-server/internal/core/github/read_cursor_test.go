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
