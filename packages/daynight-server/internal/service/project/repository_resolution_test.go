package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const resolveAddress = "https://github.com/Org/Repo.git"
const resolveTeam = "22222222-2222-4222-8222-222222222222"

var resolvePrincipal = model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444"}

type repositoryCreationPlan struct {
	*completionProjectReadPlan
	store.ProjectCreationDAO
	writes, inserts int
	created         model.Project
}

func (f *repositoryCreationPlan) WriteProjectCreation(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
	f.writes++
	if ctx != f.ctx || user != resolvePrincipal.UserID || f.snapshots != 1 || f.completion != nil {
		f.t.Fatal("creation did not follow successful snapshot")
	}
	if err := op(f); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *repositoryCreationPlan) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	if ctx != f.ctx || id != resolveTeam {
		f.t.Fatal("unexpected creation Team")
	}
	return store.ProjectCreationTeam{ID: id}, nil
}
func (f *repositoryCreationPlan) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	if ctx != f.ctx || id != resolveTeam {
		f.t.Fatal("unexpected creation membership")
	}
	return true, nil
}
func (f *repositoryCreationPlan) InsertProject(ctx context.Context, id, name, address, team string) (model.Project, model.ProjectAccess, error) {
	f.inserts++
	if ctx != f.ctx || uuid.Validate(id) != nil || name != "Repository" || address != resolveAddress || team != resolveTeam {
		f.t.Fatalf("unexpected creation: %s %s %s %s", id, name, address, team)
	}
	f.created = model.Project{ID: id, Name: name, RepoURL: address}
	return f.created, model.ProjectAccess{}, nil
}

func resolveCandidate(id, address string) model.Project {
	return model.Project{ID: id, Name: "Existing", RepoURL: address, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
}
func resolveCall(page store.Page, result store.ProjectPage, err error) completionProjectReadCall {
	return completionProjectReadCall{name: "scoped", args: []any{resolvePrincipal, store.ProjectScope{Kind: store.ProjectScopeAll}, page}, result: result, err: err}
}
func resolveFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}

func TestResolveRepositorySnapshotAndFailures(t *testing.T) {
	first := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	other := resolveCandidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "https://github.com/other")
	second := resolveCandidate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "ssh://git@github.com:22/Org/Repo")
	bad := resolveCandidate("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "https://github.com/%2f")
	queryErr := errors.New("query failed")
	completionErr := errors.New("snapshot completion failed")
	page1 := store.Page{Limit: 100}
	after := func(p model.Project) store.Page {
		return store.Page{Limit: 100, After: &store.Position{ID: p.ID, CreatedAt: p.CreatedAt}}
	}
	for _, tc := range []struct {
		name                    string
		calls                   []completionProjectReadCall
		completion, callbackErr error
		want                    model.Project
		code                    string
		cause                   error
	}{
		{name: "missing", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{other}}, nil)}, code: "not_found"},
		{name: "unique on later page", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{other}, HasMore: true}, nil), resolveCall(after(other), store.ProjectPage{Items: []model.Project{first}}, nil)}, want: first},
		{name: "ambiguity on later page", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first}, HasMore: true}, nil), resolveCall(after(first), store.ProjectPage{Items: []model.Project{second}}, nil)}, code: "resource_conflict"},
		{name: "bad candidate", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first, bad}}, nil)}, code: "invalid_input"},
		{name: "query after match", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first}, HasMore: true}, nil), resolveCall(after(first), store.ProjectPage{}, queryErr)}, callbackErr: queryErr, cause: queryErr},
		{name: "cancellation after match", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first}, HasMore: true}, nil), resolveCall(after(first), store.ProjectPage{}, context.Canceled)}, callbackErr: context.Canceled, cause: context.Canceled},
		{name: "completion after match", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first}}, nil)}, completion: completionErr, cause: completionErr},
		{name: "completion overrides refusal", calls: []completionProjectReadCall{resolveCall(page1, store.ProjectPage{Items: []model.Project{first, second}}, nil)}, completion: completionErr, cause: completionErr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			plan := newCompletionProjectReadPlan(t, ctx, tc.calls)
			plan.completion, plan.callbackErr = tc.completion, tc.callbackErr
			fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
			got, err := NewProjects(fixture).ResolveRepository(ctx, resolvePrincipal, resolveAddress)
			if tc.code != "" {
				resolveFault(t, err, tc.code)
			} else if tc.cause != nil {
				if !errors.Is(err, tc.cause) {
					t.Fatalf("error = %v, want %v", err, tc.cause)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) || fixture.writes != 0 {
				t.Fatalf("result=%+v writes=%d", got, fixture.writes)
			}
		})
	}
}

func TestResolveRepositoryValidationBeforeSnapshot(t *testing.T) {
	for _, tc := range []struct {
		principal     model.Principal
		address, code string
	}{
		{model.Principal{}, resolveAddress, "unauthenticated"}, {resolvePrincipal, "https://github.com/%2f", "invalid_input"},
	} {
		got, err := NewProjects(nil).ResolveRepository(t.Context(), tc.principal, tc.address)
		resolveFault(t, err, tc.code)
		if !reflect.DeepEqual(got, model.Project{}) {
			t.Fatalf("validation returned data: %+v", got)
		}
	}
}

func TestRegisterRepositorySnapshotAndCreationGuard(t *testing.T) {
	existing := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	team := resolveTeam
	input := core.CreateProject{Name: "Repository", RepoURL: resolveAddress, TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}
	for _, tc := range []struct {
		name    string
		items   []model.Project
		confirm bool
		code    string
		create  bool
	}{
		{"reuse without confirmation", []model.Project{existing}, false, "", false},
		{"reject unconfirmed creation", nil, false, "invalid_input", false},
		{"confirmed creation", nil, true, "", true},
		{"reject ambiguous even when confirmed", []model.Project{existing, existing}, true, "resource_conflict", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{resolveCall(store.Page{Limit: 100}, store.ProjectPage{Items: tc.items}, nil)})
			fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
			got, created, err := NewProjects(fixture).RegisterRepository(ctx, resolvePrincipal, input, tc.confirm)
			if tc.code != "" {
				resolveFault(t, err, tc.code)
				if tc.name == "reject unconfirmed creation" && err.Error() != "Project creation requires confirmation." {
					t.Fatalf("confirmation message = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			want := model.Project{}
			writes := 0
			if tc.create {
				want = fixture.created
				writes = 1
			} else if tc.code == "" {
				want = existing
			}
			if !reflect.DeepEqual(got, want) || created != tc.create || fixture.writes != writes || fixture.inserts != writes {
				t.Fatalf("result=%+v created=%v writes=%d inserts=%d", got, created, fixture.writes, fixture.inserts)
			}
		})
	}
}

func TestRegisterRepositoryDoesNotCreateAfterSnapshotFailure(t *testing.T) {
	existing := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	team := resolveTeam
	input := core.CreateProject{Name: "Repository", RepoURL: resolveAddress, TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}
	failure := errors.New("snapshot completion failed")
	for _, items := range [][]model.Project{nil, {existing}, {existing, existing}} {
		ctx := t.Context()
		plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{resolveCall(store.Page{Limit: 100}, store.ProjectPage{Items: items}, nil)})
		plan.completion = failure
		fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
		got, created, err := NewProjects(fixture).RegisterRepository(ctx, resolvePrincipal, input, true)
		if !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Project{}) || created || fixture.writes != 0 {
			t.Fatalf("result=%+v created=%v error=%v writes=%d", got, created, err, fixture.writes)
		}
	}
}
