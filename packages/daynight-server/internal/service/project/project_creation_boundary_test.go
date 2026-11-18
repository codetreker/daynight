package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type personalProjectCreationPlan struct {
	projectValidationStore
	store.ProjectCreationDAO
	t             *testing.T
	ctx           context.Context
	actor         model.Principal
	input         coreproject.CreateProject
	createdAt     time.Time
	pending       []string
	proposed      model.Project
	insertErr     error
	completion    store.Completion
	completionErr error
}

func newPersonalProjectCreationPlan(t *testing.T, ctx context.Context, actor model.Principal, input coreproject.CreateProject) *personalProjectCreationPlan {
	t.Helper()
	p := &personalProjectCreationPlan{
		t: t, ctx: ctx, actor: actor, input: input,
		createdAt:  time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC),
		pending:    []string{"WriteProjectCreation", "CreationPersonalTeam", "InsertProject"},
		completion: store.Completion{Outcome: store.TransactionCommitted},
	}
	t.Cleanup(func() {
		if len(p.pending) != 0 {
			t.Errorf("unconsumed Project creation calls: %v", p.pending)
		}
	})
	return p
}

func (p *personalProjectCreationPlan) take(ctx context.Context, name string) {
	p.t.Helper()
	if p.ctx != ctx || len(p.pending) == 0 || p.pending[0] != name {
		p.t.Fatalf("unexpected Project creation call %s: same context=%v pending=%v", name, ctx == p.ctx, p.pending)
	}
	p.pending = p.pending[1:]
}

func (p *personalProjectCreationPlan) WriteProjectCreation(ctx context.Context, userID string, work func(store.ProjectCreationDAO) error) (store.Completion, error) {
	p.take(ctx, "WriteProjectCreation")
	if userID != p.actor.UserID {
		p.t.Fatalf("Project creation owner=%q, want user %q", userID, p.actor.UserID)
	}
	if err := work(p); !errors.Is(err, p.insertErr) {
		p.t.Fatalf("Project creation callback error=%v, want %v", err, p.insertErr)
	}
	return p.completion, p.completionErr
}

func (p *personalProjectCreationPlan) CreationPersonalTeam(ctx context.Context, lock bool) (store.PersonalTeamFacts, error) {
	p.take(ctx, "CreationPersonalTeam")
	if !lock {
		p.t.Fatal("Project creation must lock the Personal Team")
	}
	return store.PersonalTeamFacts{ID: projectProjectionTeam, MemberCount: 1, OwnerAdminCount: 1}, nil
}

func (p *personalProjectCreationPlan) InsertProject(ctx context.Context, id, name, address, identity, teamID string) (model.Project, model.ProjectAccess, error) {
	p.take(ctx, "InsertProject")
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.Version() != 4 || parsed.String() != id {
		p.t.Fatalf("Project creation ID=%q, want canonical UUIDv4", id)
	}
	if name != p.input.Name || address != p.input.RepoURL || teamID != projectProjectionTeam {
		p.t.Fatalf("Project insertion: name=%q address=%q team=%q, want %q %q %q", name, address, teamID, p.input.Name, p.input.RepoURL, projectProjectionTeam)
	}
	p.proposed = model.Project{
		ID: id, Name: name, RepoURL: address, CreatedAt: p.createdAt, UpdatedAt: p.createdAt,
		Settings:  model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60},
		Ownership: model.ProjectOwnership{TeamID: teamID, Version: 1, UpdatedAt: p.createdAt},
	}
	if p.insertErr != nil {
		return model.Project{}, model.ProjectAccess{}, p.insertErr
	}
	return p.proposed, personalProjectCreatorAccess(p.proposed, p.actor), nil
}

func personalProjectCreatorAccess(project model.Project, actor model.Principal) model.ProjectAccess {
	role := model.ProjectAdmin
	return model.ProjectAccess{
		ProjectID: project.ID, UserID: actor.UserID, Role: role, TeamRole: &role, CanTransfer: true,
		DirectGrant: &model.ProjectGrant{
			ProjectID: project.ID, UserID: actor.UserID, Role: role, Version: 2,
			CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt,
		},
		OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"},
		Ownership: project.Ownership,
	}
}

func TestCreateAndGetProject(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	ctx := t.Context()
	input := coreproject.CreateProject{ExpectedUserID: actor.UserID, Name: "  Application project  ", RepoURL: "ssh://git@Git.Example:2222/Team/Application.git"}
	creation := newPersonalProjectCreationPlan(t, ctx, actor, input)
	first, err := NewProjects(creation).Create(ctx, actor, input)
	if err != nil || first != creation.proposed || first.Name != input.Name || first.RepoURL != input.RepoURL ||
		first.CreatedAt.IsZero() || !first.CreatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("created project: %#v, %v, want %#v", first, err, creation.proposed)
	}

	read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
		{name: "access", args: []any{actor, first.ID}, result: personalProjectCreatorAccess(first, actor)},
		{name: "project", args: []any{first.ID}, result: first},
	})
	got, err := NewProjects(read).Get(ctx, actor, strings.ToUpper(first.ID))
	if err != nil || got != first {
		t.Fatalf("read canonical ID: %#v, %v, want %#v", got, err, first)
	}

	creation = newPersonalProjectCreationPlan(t, ctx, actor, input)
	second, err := NewProjects(creation).Create(ctx, actor, input)
	if err != nil || second != creation.proposed || second.ID == first.ID {
		t.Fatalf("same repository must support independent projects: %#v, %v, want %#v with a new ID", second, err, creation.proposed)
	}

	const missingID = "00000000-0000-0000-0000-000000000000"
	read = newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
		{name: "access", args: []any{actor, missingID}, err: model.ErrNotFound},
	})
	got, err = NewProjects(read).Get(ctx, actor, missingID)
	fault := requireFault(t, err, "not_found")
	if got != (model.Project{}) || !errors.Is(fault, model.ErrNotFound) || fault.TaskIDs != nil || fault.Unwrap() == nil {
		t.Fatalf("missing Project returned data or lost its cause: %#v, %#v", got, fault)
	}
}

func TestPrivateProjectsAtomicCreationAndMemberFilteredPagination(t *testing.T) {
	alice, stranger := projectProjectionPrincipal(1), projectProjectionPrincipal(3)
	ctx := t.Context()
	input := coreproject.CreateProject{ExpectedUserID: alice.UserID, Name: "A", RepoURL: "https://example.com/team/repo.git"}
	creation := newPersonalProjectCreationPlan(t, ctx, alice, input)
	a, access, err := NewProjects(creation).CreateWithAccess(ctx, alice, input)
	if err != nil || a != creation.proposed || !reflect.DeepEqual(access, personalProjectCreatorAccess(a, alice)) {
		t.Fatalf("created Project and creator access: %#v, %#v, %v", a, access, err)
	}

	b := projectPageItem(2, a.CreatedAt.Add(time.Second))
	c := projectPageItem(3, a.CreatedAt.Add(2*time.Second))
	b.Name, b.RepoURL = "B", a.RepoURL
	c.Name, c.RepoURL = "C", a.RepoURL
	visible := []model.Project{a, b, c}
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	request := model.PageRequest{Limit: 1}
	expected := store.Page{Limit: 1}
	for i, project := range visible {
		items := []model.Project{project}
		more := i < len(visible)-1
		page, err := projectPageSubject(t, alice, scope, expected, items, more).List(ctx, alice, request)
		requireProjectPage(t, page, err, items, more)
		request.Cursor = page.NextCursor
		expected.After = projectPageAfter(project)
	}
	empty := []model.Project{}
	page, err := projectPageSubject(t, stranger, scope, store.Page{Limit: 1}, empty, false).List(ctx, stranger, model.PageRequest{Limit: 1})
	requireProjectPage(t, page, err, empty, false)

	input = coreproject.CreateProject{ExpectedUserID: alice.UserID, Name: "Must roll back", RepoURL: "host:repo"}
	creation = newPersonalProjectCreationPlan(t, ctx, alice, input)
	initialGrant := &store.Error{
		Phase: "insert project administrator", DatabaseFailure: true, SQLState: "P0001",
		Cause: &pgconn.PgError{Code: "P0001", Message: "injected admin insertion failure"},
	}
	creation.insertErr = initialGrant
	creation.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	rollback := &store.Error{
		Phase: "create project", DatabaseFailure: true, SQLState: initialGrant.SQLState,
		Cause: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: initialGrant},
	}
	creation.completionErr = rollback
	failed, err := NewProjects(creation).Create(ctx, alice, input)
	assertProjectStoreFailure(t, failed, err, rollback)
	if !errors.Is(err, initialGrant) || !errors.Is(err, initialGrant.Cause) || creation.proposed.ID == "" {
		t.Fatalf("Project creation did not reach the initial grant failure: %v", err)
	}
}

func (p *personalProjectCreationPlan) RepositoryOccupied(ctx context.Context, team, identity string) (bool,error) {
 if ctx != p.ctx || team != projectProjectionTeam || identity == "" { p.t.Fatal("unexpected repository occupancy") }; return false,nil
}
