package github

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const projectID = "11111111-1111-4111-8111-111111111111"

var principal = model.Principal{UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333", Kind: model.PATCredential}

type fixture struct {
	store.SnapshotScope
	store.ProjectReader
	store.GitHubReadDAO
	trace                                                                  []string
	accessErr, connectionErr, countsErr, listErr, detailErr, completionErr error
	page                                                                   store.GitHubPRPage
	counts                                                                 store.GitHubPRCounts
	query                                                                  store.GitHubPRQuery
	wantCtx                                                                context.Context
}

func (f *fixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	f.trace = append(f.trace, "snapshot")
	if ctx != f.wantCtx {
		panic("context changed at snapshot")
	}
	if err := fn(f); err != nil {
		return err
	}
	return f.completionErr
}
func (f *fixture) ProjectDAO() store.ProjectReader { return f }
func (f *fixture) GitHubDAO() store.GitHubReadDAO  { return f }
func (f *fixture) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	f.trace = append(f.trace, "access")
	if ctx != f.wantCtx || p != principal || id != projectID {
		panic("incorrect access arguments")
	}
	return model.ProjectAccess{ProjectID: id, UserID: p.UserID}, f.accessErr
}
func (f *fixture) Connection(ctx context.Context, id string) (githubpr.Connection, error) {
	f.trace = append(f.trace, "connection")
	if ctx != f.wantCtx || id != projectID {
		panic("incorrect connection arguments")
	}
	return githubpr.Connection{ProjectID: id, Revision: 7}, f.connectionErr
}
func (f *fixture) PullRequest(ctx context.Context, id string, n int64) (githubpr.PullRequest, error) {
	f.trace = append(f.trace, "detail")
	if ctx != f.wantCtx || id != projectID || n != 42 {
		panic("incorrect detail arguments")
	}
	return githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: n}}, f.detailErr
}
func (f *fixture) PullRequests(ctx context.Context, q store.GitHubPRQuery) (store.GitHubPRPage, error) {
	f.trace = append(f.trace, "list")
	if ctx != f.wantCtx {
		panic("incorrect list context")
	}
	f.query = q
	return f.page, f.listErr
}
func (f *fixture) PullRequestCounts(ctx context.Context, id string) (store.GitHubPRCounts, error) {
	f.trace = append(f.trace, "counts")
	if ctx != f.wantCtx || id != projectID {
		panic("incorrect count arguments")
	}
	return f.counts, f.countsErr
}
func fixtureFor(ctx context.Context) *fixture { return &fixture{wantCtx: ctx} }
func faultCode(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("got %v, want fault %q", err, code)
	}
}

func TestReadAuthorizationAndFailures(t *testing.T) {
	ctx := context.Background()
	cause := errors.New("storage failed")
	for _, tc := range []struct {
		name      string
		configure func(*fixture)
		wantTrace []string
		wantErr   error
		wantCode  string
	}{
		{"non-member", func(f *fixture) { f.accessErr = &model.Fault{Code: "forbidden"} }, []string{"snapshot", "access"}, nil, "forbidden"},
		{"missing project", func(f *fixture) { f.accessErr = model.ErrNotFound }, []string{"snapshot", "access"}, model.ErrNotFound, "not_found"},
		{"access failure", func(f *fixture) { f.accessErr = cause }, []string{"snapshot", "access"}, cause, ""},
		{"connection failure", func(f *fixture) { f.connectionErr = cause }, []string{"snapshot", "access", "connection"}, cause, ""},
		{"counts failure", func(f *fixture) { f.countsErr = cause }, []string{"snapshot", "access", "connection", "counts"}, cause, ""},
		{"list failure", func(f *fixture) { f.listErr = cause }, []string{"snapshot", "access", "connection", "counts", "list"}, cause, ""},
		{"completion failure", func(f *fixture) { f.completionErr = cause }, []string{"snapshot", "access", "connection", "counts", "list"}, cause, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixtureFor(ctx)
			tc.configure(f)
			page, err := NewReader(f, true).List(ctx, principal, projectID, ListRequest{State: "active", Limit: 20})
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("error %v does not wrap %v", err, tc.wantErr)
			}
			if tc.wantCode != "" {
				faultCode(t, err, tc.wantCode)
			}
			if !reflect.DeepEqual(f.trace, tc.wantTrace) {
				t.Fatalf("trace %v, want %v", f.trace, tc.wantTrace)
			}
			if !reflect.DeepEqual(page, Page{}) {
				t.Fatalf("failed read yielded page: %+v", page)
			}
		})
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	f := fixtureFor(cancelled)
	f.listErr = context.Canceled
	_, err := NewReader(f, false).List(cancelled, principal, projectID, ListRequest{State: "all", Limit: 1})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestReadStatusAndDetail(t *testing.T) {
	ctx := context.Background()
	f := fixtureFor(ctx)
	status, err := NewReader(f, false).Get(ctx, principal, projectID)
	if err != nil || status.ServiceAvailable || status.Connection.Revision != 7 || !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection"}) {
		t.Fatalf("status=%+v trace=%v error=%v", status, f.trace, err)
	}
	f = fixtureFor(ctx)
	detail, err := NewReader(f, false).Detail(ctx, principal, projectID, 42)
	if err != nil || detail.PullRequest.Number != 42 || detail.Connection.Revision != 7 || !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "detail"}) {
		t.Fatalf("detail=%+v trace=%v error=%v", detail, f.trace, err)
	}
	f = fixtureFor(ctx)
	f.detailErr = model.ErrNotFound
	_, err = NewReader(f, false).Detail(ctx, principal, projectID, 42)
	faultCode(t, err, "not_found")
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing cause: %v", err)
	}
	f = fixtureFor(ctx)
	_, err = NewReader(f, false).Detail(ctx, principal, projectID, 0)
	faultCode(t, err, "invalid_input")
	if len(f.trace) != 0 {
		t.Fatalf("invalid number read database: %v", f.trace)
	}
}

func TestListValidationAndEmptyPage(t *testing.T) {
	ctx := context.Background()
	for _, req := range []ListRequest{
		{State: "open", Limit: 1}, {State: "active", Limit: 0}, {State: "active", Limit: 101},
		{State: "all", Limit: 1, Query: strings.Repeat("a", 1025)}, {State: "all", Limit: 1, Query: "\x00"}, {State: "all", Limit: 1, Query: "\xff"},
	} {
		f := fixtureFor(ctx)
		_, err := NewReader(f, true).List(ctx, principal, projectID, req)
		faultCode(t, err, "invalid_input")
		if len(f.trace) != 0 {
			t.Fatalf("invalid request read database: %v", f.trace)
		}
	}
	f := fixtureFor(ctx)
	f.counts = store.GitHubPRCounts{Active: 2, All: 2}
	page, err := NewReader(f, false).List(ctx, principal, projectID, ListRequest{State: "merged", Limit: 100, Query: strings.Repeat("é", 512)})
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.Total != 0 || page.Counts != f.counts || page.NextCursor != nil || page.PreviousCursor != nil {
		t.Fatalf("empty page %+v, %v", page, err)
	}
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "counts", "list"}) || f.query.ProjectID != projectID || f.query.State != "merged" || f.query.Limit != 100 {
		t.Fatalf("query %+v trace %v", f.query, f.trace)
	}
}
