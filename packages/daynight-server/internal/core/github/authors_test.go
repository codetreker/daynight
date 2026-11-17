package github

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type authorsFixture struct {
	*fixture
	page  store.GitHubAuthorPage
	err   error
	query store.GitHubAuthorQuery
}

func (f *authorsFixture) GitHubDAO() store.GitHubReadDAO { return f }
func (f *authorsFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	f.trace = append(f.trace, "snapshot")
	if ctx != f.wantCtx {
		panic("context changed")
	}
	if err := fn(f); err != nil {
		return err
	}
	return f.completionErr
}
func (f *authorsFixture) Authors(ctx context.Context, q store.GitHubAuthorQuery) (store.GitHubAuthorPage, error) {
	f.trace = append(f.trace, "authors")
	if ctx != f.wantCtx {
		panic("context changed")
	}
	f.query = q
	return f.page, f.err
}
func TestAuthorsSnapshotAndCursor(t *testing.T) {
	ctx := context.Background()
	f := &authorsFixture{fixture: fixtureFor(ctx), page: store.GitHubAuthorPage{Items: []githubpr.Author{{ID: 9007199254740997, Login: "Name", NameKey: "name", LoginAmbiguous: true}}, HasMore: true}}
	req := AuthorsRequest{Query: "a", Limit: 1}
	page, err := NewReader(f, false).Authors(ctx, principal, projectID, req)
	if err != nil || page.NextCursor == nil || page.Items[0].ID != 9007199254740997 || !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "authors"}) {
		t.Fatalf("page=%+v trace=%v err=%v", page, f.trace, err)
	}
	f.trace = nil
	f.page = store.GitHubAuthorPage{}
	req.Cursor = *page.NextCursor
	page, err = NewReader(f, false).Authors(ctx, principal, projectID, req)
	if err != nil || page.Items == nil || page.NextCursor != nil || *f.query.AnchorNameKey != "name" || *f.query.AnchorAuthorID != 9007199254740997 {
		t.Fatalf("page=%+v query=%+v err=%v", page, f.query, err)
	}
	for _, changed := range []AuthorsRequest{{Query: "b", Limit: 1, Cursor: req.Cursor}, {Query: "a", Limit: 2, Cursor: req.Cursor}} {
		_, err = NewReader(f, false).Authors(ctx, principal, projectID, changed)
		faultCode(t, err, "invalid_input")
	}
	_, err = NewReader(f, false).Authors(ctx, principal, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", req)
	faultCode(t, err, "invalid_input")
	c, _ := encodeAuthorCursor(projectID, req, 8, githubpr.Author{ID: 1, NameKey: "a"})
	req.Cursor = *c
	f.trace = nil
	_, err = NewReader(f, false).Authors(ctx, principal, projectID, req)
	faultCode(t, err, "resource_conflict")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection"}) {
		t.Fatal(f.trace)
	}
}
func TestAuthorsValidationAndFailures(t *testing.T) {
	ctx := context.Background()
	f := &authorsFixture{fixture: fixtureFor(ctx)}
	for _, req := range []AuthorsRequest{{Limit: 0}, {Limit: 101}, {Limit: 1, Query: strings.Repeat("a", 1025)}, {Limit: 1, Query: "\x00"}, {Limit: 1, Query: "\xff"}} {
		_, err := NewReader(f, false).Authors(ctx, principal, projectID, req)
		faultCode(t, err, "invalid_input")
	}
	if len(f.trace) != 0 {
		t.Fatal(f.trace)
	}
	for _, raw := range []string{`{}`, `{"v":1,"v":1,"projectId":"` + projectID + `","q":"","limit":1,"revision":"7","nameKey":"x","authorId":"1"}`, `{"v":1,"projectId":"` + projectID + `","q":"","limit":1,"revision":"07","nameKey":"x","authorId":"1"}`, `{"v":1,"projectId":"` + projectID + `","q":"","limit":1,"revision":"7","nameKey":null,"authorId":"1"}`} {
		_, err := decodeAuthorCursor(base64.RawURLEncoding.EncodeToString([]byte(raw)), projectID, AuthorsRequest{Limit: 1})
		faultCode(t, err, "invalid_input")
	}
	f.accessErr = &model.Fault{Code: "forbidden"}
	_, err := NewReader(f, false).Authors(ctx, principal, projectID, AuthorsRequest{Limit: 1})
	faultCode(t, err, "forbidden")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
		t.Fatal(f.trace)
	}
	f = &authorsFixture{fixture: fixtureFor(ctx), err: context.Canceled}
	_, err = NewReader(f, false).Authors(ctx, principal, projectID, AuthorsRequest{Limit: 1})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f = &authorsFixture{fixture: fixtureFor(ctx), page: store.GitHubAuthorPage{Items: []githubpr.Author{{ID: 1, NameKey: strings.Repeat("x", 20000)}}, HasMore: true}}
	_, err = NewReader(f, false).Authors(ctx, principal, projectID, AuthorsRequest{Limit: 1})
	if err == nil {
		t.Fatal("oversized cursor accepted")
	}
}
