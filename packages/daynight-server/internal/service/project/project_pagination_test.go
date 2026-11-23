package project

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

const projectProjectionTeam = "ab000000-0000-4000-8000-000000000001"

func projectProjectionPrincipal(n int) model.Principal {
	return model.Principal{
		UserID:       fmt.Sprintf("cd000000-0000-4000-8000-%012d", n),
		CredentialID: fmt.Sprintf("de000000-0000-4000-8000-%012d", n),
		Kind:         model.SessionCredential,
	}
}

func projectPageItem(n int, created time.Time) model.Project {
	return model.Project{
		ID:        fmt.Sprintf("ef000000-0000-4000-8000-%012d", n),
		Name:      fmt.Sprint(n),
		RepoURL:   "host:repo",
		CreatedAt: created,
		UpdatedAt: created.Add(time.Minute),
		Settings:  model.ProjectSettings{Version: int64(n) + 1, ExecutionWarningMinutes: 45 + int32(n)},
		Ownership: model.ProjectOwnership{TeamID: projectProjectionTeam, Version: int64(n), UpdatedAt: created.Add(time.Second)},
	}
}

func projectPageAfter(project model.Project) *store.Position {
	return &store.Position{CreatedAt: project.CreatedAt, ID: project.ID}
}

func projectPageSubject(t *testing.T, principal model.Principal, scope store.ProjectScope, page store.Page, items []model.Project, hasMore bool) *Projects {
	t.Helper()
	return NewProjects(newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
		{
			name:   "scoped",
			args:   []any{principal, scope, page},
			result: store.ProjectPage{Items: slices.Clone(items), HasMore: hasMore},
		},
	}))
}

func requireProjectPage(t *testing.T, page coreproject.ProjectPage, err error, items []model.Project, hasMore bool) {
	t.Helper()
	if err != nil || !reflect.DeepEqual(page.Items, items) || (page.NextCursor != nil) != hasMore {
		t.Fatalf("Project page = %#v, %v, want items %#v and cursor present=%v", page, err, items, hasMore)
	}
}

func TestProjectPagination(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	ctx := t.Context()
	emptyItems := []model.Project{}
	empty, err := projectPageSubject(t, actor, scope, store.Page{Limit: 1}, emptyItems, false).List(ctx, actor, model.PageRequest{Limit: 1})
	requireProjectPage(t, empty, err, emptyItems, false)

	timestamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	items := []model.Project{
		projectPageItem(1, timestamp),
		projectPageItem(2, timestamp),
		projectPageItem(3, timestamp),
		projectPageItem(4, timestamp),
	}
	first, err := projectPageSubject(t, actor, scope, store.Page{Limit: 2}, items[:2], true).List(ctx, actor, model.PageRequest{Limit: 2})
	requireProjectPage(t, first, err, items[:2], true)

	request := model.PageRequest{Limit: 2, Cursor: first.NextCursor}
	wantPage := store.Page{Limit: 2, After: projectPageAfter(items[1])}
	parsed, err := query.ProjectListPage(request, actor.UserID, scope)
	if err != nil || !reflect.DeepEqual(parsed, wantPage) {
		t.Fatalf("cursor must encode the exact last position: %#v, %v, want %#v", parsed, err, wantPage)
	}
	last, err := projectPageSubject(t, actor, scope, wantPage, items[2:], false).List(ctx, actor, request)
	requireProjectPage(t, last, err, items[2:], false)

	all, err := projectPageSubject(t, actor, scope, store.Page{Limit: 100}, items, false).List(ctx, actor, model.PageRequest{Limit: 100})
	requireProjectPage(t, all, err, items, false)
}

func TestProjectScopedPaginationAndValidation(t *testing.T) {
	owner, outsider := projectProjectionPrincipal(1), projectProjectionPrincipal(2)
	created := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	items := []model.Project{
		projectPageItem(1, created),
		projectPageItem(2, created.Add(time.Second)),
		projectPageItem(3, created.Add(2*time.Second)),
	}
	ctx := t.Context()
	teamID := projectProjectionTeam
	teamScope := store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: teamID}
	team := coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: pointer(strings.ToUpper(teamID))}
	first, err := projectPageSubject(t, owner, teamScope, store.Page{Limit: 1}, items[:1], true).ListScoped(ctx, owner, team)
	requireProjectPage(t, first, err, items[:1], true)

	team.TeamID = &teamID
	team.Page.Cursor = first.NextCursor
	second, err := projectPageSubject(t, owner, teamScope, store.Page{Limit: 1, After: projectPageAfter(items[0])}, items[1:2], true).ListScoped(ctx, owner, team)
	requireProjectPage(t, second, err, items[1:2], true)

	team.Page.Cursor = second.NextCursor
	last, err := projectPageSubject(t, owner, teamScope, store.Page{Limit: 1, After: projectPageAfter(items[1])}, items[2:], false).ListScoped(ctx, owner, team)
	requireProjectPage(t, last, err, items[2:], false)

	sharedScope := store.ProjectScope{Kind: store.ProjectScopeShared}
	shared := coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}, Shared: true}
	sharedFirst, err := projectPageSubject(t, outsider, sharedScope, store.Page{Limit: 1}, items[:1], true).ListScoped(ctx, outsider, shared)
	requireProjectPage(t, sharedFirst, err, items[:1], true)

	shared.Page.Cursor = sharedFirst.NextCursor
	sharedLast, err := projectPageSubject(t, outsider, sharedScope, store.Page{Limit: 1, After: projectPageAfter(items[0])}, items[1:2], false).ListScoped(ctx, outsider, shared)
	requireProjectPage(t, sharedLast, err, items[1:2], false)

	validation := NewProjects(projectValidationStore{})
	for _, test := range []struct {
		name    string
		actor   model.Principal
		request coreproject.ProjectListRequest
	}{
		{"Team cursor in all scope", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}}},
		{"Team cursor in Shared scope", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}, Shared: true}},
		{"Shared cursor in Team scope", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: sharedFirst.NextCursor}, TeamID: &teamID}},
		{"Team and Shared", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: &teamID, Shared: true}},
		{"empty Team ID", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: pointer("")}},
		{"invalid Team ID", owner, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: pointer("not-a-uuid")}},
		{"Team cursor for another principal", outsider, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}, TeamID: &teamID}},
	} {
		t.Run(test.name, func(t *testing.T) {
			page, err := validation.ListScoped(t.Context(), test.actor, test.request)
			requireFault(t, err, "invalid_input")
			if !reflect.DeepEqual(page, coreproject.ProjectPage{}) {
				t.Fatalf("invalid scope returned a page: %#v", page)
			}
		})
	}

	team.Page.Cursor = nil
	t.Run("Team not found", func(t *testing.T) {
		db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
			{name: "scoped", args: []any{outsider, teamScope, store.Page{Limit: 1}}, err: model.ErrNotFound},
		})
		page, err := NewProjects(db).ListScoped(t.Context(), outsider, team)
		fault := requireFault(t, err, "not_found")
		if !errors.Is(fault, model.ErrNotFound) || !reflect.DeepEqual(page, coreproject.ProjectPage{}) {
			t.Fatalf("Team refusal must retain cause without a page: %#v, %v", page, fault)
		}
	})
	t.Run("Team membership query failed", func(t *testing.T) {
		failure := &store.Error{
			Phase:           "read team membership",
			Cause:           &pgconn.PgError{Code: "42P01", Message: "team_members relation missing"},
			SQLState:        "42P01",
			DatabaseFailure: true,
		}
		db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
			{name: "scoped", args: []any{owner, teamScope, store.Page{Limit: 1}}, err: failure},
		})
		db.callbackErr = failure
		page, err := NewProjects(db).ListScoped(t.Context(), owner, team)
		assertProjectStoreFailure(t, page, err, failure)
	})
}
