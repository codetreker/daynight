package project

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type repositoryPageReader struct {
	store.ProjectReader
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	pages     []store.ProjectPage
	failure   error
	calls     int
	cancel    context.CancelFunc
}

func (r *repositoryPageReader) ScopedProjects(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	r.t.Helper()
	if ctx != r.ctx || p != r.principal || scope.Kind != store.ProjectScopeAll || page.Limit != 100 || (r.calls == 0) != (page.After == nil) {
		r.t.Fatalf("unexpected page call: principal=%+v scope=%+v page=%+v", p, scope, page)
	}
	if r.calls >= len(r.pages) {
		r.calls++
		return store.ProjectPage{}, r.failure
	}
	result := r.pages[r.calls]
	r.calls++
	if r.cancel != nil {
		r.cancel()
	}
	return result, nil
}

func TestFindRepositoryPagesAndErrors(t *testing.T) {
	ctx := context.WithValue(context.Background(), struct{}{}, "scope")
	principal := testPrincipal()
	target := model.Project{ID: testProject, RepoURL: "git@example.com:Org/Repo.git", CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	other := model.Project{ID: testTeam, RepoURL: "https://example.com/other", CreatedAt: target.CreatedAt}
	dbErr := errors.New("query failed")
	cases := []struct {
		name     string
		pages    []store.ProjectPage
		failure  error
		wantID   string
		wantCode string
		wantErr  error
		calls    int
	}{
		{name: "empty", pages: []store.ProjectPage{{}}, calls: 1},
		{name: "later match", pages: []store.ProjectPage{{Items: []model.Project{other}, HasMore: true}, {Items: []model.Project{target}}}, wantID: target.ID, calls: 2},
		{name: "ambiguous later", pages: []store.ProjectPage{{Items: []model.Project{target}, HasMore: true}, {Items: []model.Project{target}, HasMore: true}}, wantCode: "resource_conflict", calls: 2},
		{name: "bad candidate", pages: []store.ProjectPage{{Items: []model.Project{target, {RepoURL: "invalid"}}}}, wantCode: "invalid_input", calls: 1},
		{name: "later query failure", pages: []store.ProjectPage{{Items: []model.Project{target}, HasMore: true}}, failure: dbErr, wantErr: dbErr, calls: 2},
		{name: "invalid cursor", pages: []store.ProjectPage{{Items: []model.Project{{ID: "bad", RepoURL: "https://example.com/other", CreatedAt: target.CreatedAt}}, HasMore: true}}, wantCode: "invalid_input", calls: 1},
		{name: "cursor encoding failure", pages: []store.ProjectPage{{Items: []model.Project{{ID: testProject, RepoURL: "https://example.com/other", CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}}, HasMore: true}}, wantErr: errAny, calls: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reader := &repositoryPageReader{t: t, ctx: ctx, principal: principal, pages: tc.pages, failure: tc.failure}
			match, err := NewRepositoryMatch("https://example.com/Org/Repo")
			if err != nil {
				t.Fatal(err)
			}
			got, found, err := FindRepository(ctx, reader, principal, match)
			if tc.wantCode != "" {
				faultCode(t, err, tc.wantCode)
			} else if tc.wantErr == errAny {
				if err == nil {
					t.Fatal("expected error")
				}
			} else if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error: %v", err)
			}
			if got.ID != tc.wantID || found != (tc.wantID != "") || reader.calls != tc.calls {
				t.Fatalf("result=%+v found=%v calls=%d err=%v", got, found, reader.calls, err)
			}
		})
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	reader := &repositoryPageReader{t: t, ctx: canceled, principal: principal}
	match, _ := NewRepositoryMatch("https://example.com/Org/Repo")
	if _, found, err := FindRepository(canceled, reader, principal, match); found || !errors.Is(err, context.Canceled) || reader.calls != 0 {
		t.Fatalf("cancellation: found=%v err=%v calls=%d", found, err, reader.calls)
	}
	ctx, cancel = context.WithCancel(context.Background())
	reader = &repositoryPageReader{t: t, ctx: ctx, principal: principal, pages: []store.ProjectPage{{}}, cancel: cancel}
	match, _ = NewRepositoryMatch("https://example.com/Org/Repo")
	if _, found, err := FindRepository(ctx, reader, principal, match); found || !errors.Is(err, context.Canceled) || reader.calls != 1 {
		t.Fatalf("cancellation after empty read: found=%v err=%v calls=%d", found, err, reader.calls)
	}
}

var errAny = errors.New("any error")
