package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type repositoryPageCall struct {
	page   store.Page
	result store.ProjectPage
	err    error
}

type repositoryPageReader struct {
	store.ProjectReader
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	calls     []repositoryPageCall
	called    int
	cancel    context.CancelFunc
}

func (r *repositoryPageReader) ScopedProjects(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	r.t.Helper()
	if r.called >= len(r.calls) {
		r.t.Fatalf("unexpected query %d: principal=%+v scope=%+v page=%+v", r.called+1, p, scope, page)
	}
	call := r.calls[r.called]
	r.called++
	if ctx != r.ctx || p != r.principal || scope != (store.ProjectScope{Kind: store.ProjectScopeAll}) || !reflect.DeepEqual(page, call.page) {
		r.t.Fatalf("unexpected query %d: principal=%+v scope=%+v page=%+v, want page=%+v", r.called, p, scope, page, call.page)
	}
	if r.cancel != nil {
		r.cancel()
	}
	return call.result, call.err
}

func TestFindRepositoryPagesAndErrors(t *testing.T) {
	ctx := context.WithValue(context.Background(), struct{}{}, "scope")
	principal := testPrincipal()
	target := model.Project{ID: testProject, RepoURL: "git@example.com:Org/Repo.git", CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	other := model.Project{ID: testTeam, RepoURL: "https://example.com/other", CreatedAt: target.CreatedAt}
	dbErr := errors.New("query failed")
	page1 := store.Page{Limit: 100}
	after := func(p model.Project) store.Page {
		return store.Page{Limit: 100, After: &store.Position{ID: p.ID, CreatedAt: p.CreatedAt}}
	}
	resolvePrincipal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444"}
	resolveCandidate := func(id, address string) model.Project {
		return model.Project{ID: id, Name: "Existing", RepoURL: address, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	}
	first := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	resolveOther := resolveCandidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "https://github.com/other")
	second := resolveCandidate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "ssh://git@github.com:22/Org/Repo")
	bad := resolveCandidate("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "https://github.com/%2f")
	resolveAddress := "https://github.com/Org/Repo.git"
	cases := []struct {
		name      string
		principal model.Principal
		address   string
		calls     []repositoryPageCall
		want      model.Project
		found     bool
		wantCode  string
		wantErr   error
	}{
		{name: "empty", calls: []repositoryPageCall{{page: page1}}},
		{name: "later match", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{other}, HasMore: true}}, {page: after(other), result: store.ProjectPage{Items: []model.Project{target}}}}, want: target, found: true},
		{name: "ambiguous later", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{target}, HasMore: true}}, {page: after(target), result: store.ProjectPage{Items: []model.Project{target}, HasMore: true}}}, wantCode: "resource_conflict"},
		{name: "bad candidate", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{target, {RepoURL: "invalid"}}}}}, wantCode: "invalid_input"},
		{name: "later query failure", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{target}, HasMore: true}}, {page: after(target), err: dbErr}}, wantErr: dbErr},
		{name: "invalid cursor", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{{ID: "bad", RepoURL: "https://example.com/other", CreatedAt: target.CreatedAt}}, HasMore: true}}}, wantCode: "invalid_input"},
		{name: "cursor encoding failure", calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{{ID: testProject, RepoURL: "https://example.com/other", CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}}, HasMore: true}}}, wantErr: errAny},
		{name: "resolve missing", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{resolveOther}}}}},
		{name: "resolve unique on later page", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{resolveOther}, HasMore: true}}, {page: after(resolveOther), result: store.ProjectPage{Items: []model.Project{first}}}}, want: first, found: true},
		{name: "resolve ambiguity on later page", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{first}, HasMore: true}}, {page: after(first), result: store.ProjectPage{Items: []model.Project{second}}}}, wantCode: "resource_conflict"},
		{name: "resolve bad candidate", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{first, bad}}}}, wantCode: "invalid_input"},
		{name: "resolve query after match", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{first}, HasMore: true}}, {page: after(first), err: dbErr}}, wantErr: dbErr},
		{name: "resolve cancellation after match", principal: resolvePrincipal, address: resolveAddress, calls: []repositoryPageCall{{page: page1, result: store.ProjectPage{Items: []model.Project{first}, HasMore: true}}, {page: after(first), err: context.Canceled}}, wantErr: context.Canceled},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, address := tc.principal, tc.address
			if address == "" {
				p, address = principal, "https://example.com/Org/Repo"
			}
			reader := &repositoryPageReader{t: t, ctx: ctx, principal: p, calls: tc.calls}
			match, err := NewRepositoryMatch(address)
			if err != nil {
				t.Fatal(err)
			}
			got, found, err := FindRepository(ctx, reader, p, match)
			if tc.wantCode != "" {
				faultCode(t, err, tc.wantCode)
			} else if tc.wantErr == errAny {
				if err == nil {
					t.Fatal("expected error")
				}
			} else if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error: %v, want %v", err, tc.wantErr)
			}
			if !reflect.DeepEqual(got, tc.want) || found != tc.found || reader.called != len(tc.calls) {
				t.Fatalf("result=%+v found=%v calls=%d err=%v; want result=%+v found=%v calls=%d", got, found, reader.called, err, tc.want, tc.found, len(tc.calls))
			}
		})
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	reader := &repositoryPageReader{t: t, ctx: canceled, principal: principal}
	match, _ := NewRepositoryMatch("https://example.com/Org/Repo")
	if got, found, err := FindRepository(canceled, reader, principal, match); !reflect.DeepEqual(got, model.Project{}) || found || !errors.Is(err, context.Canceled) || reader.called != 0 {
		t.Fatalf("cancellation: result=%+v found=%v err=%v calls=%d", got, found, err, reader.called)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	reader = &repositoryPageReader{t: t, ctx: ctx, principal: principal, calls: []repositoryPageCall{{page: page1}}, cancel: cancel}
	match, _ = NewRepositoryMatch("https://example.com/Org/Repo")
	if got, found, err := FindRepository(ctx, reader, principal, match); !reflect.DeepEqual(got, model.Project{}) || found || !errors.Is(err, context.Canceled) || reader.called != 1 {
		t.Fatalf("cancellation after empty read: result=%+v found=%v err=%v calls=%d", got, found, err, reader.called)
	}
}

var errAny = errors.New("any error")
