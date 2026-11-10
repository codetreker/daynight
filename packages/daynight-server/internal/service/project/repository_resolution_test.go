package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	session "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
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

// resolveSnapshot passes its own scope to the callback, so the DAO capability
// observed by the operation is the one bound to this snapshot.
type resolveSnapshot struct {
	store.SnapshotScope
	store.ProjectReader
	t                           *testing.T
	ctx                         context.Context
	snapshots, daoCalls, writes int
	callbackWant, completion    error
}

func (s *resolveSnapshot) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	s.snapshots++
	if ctx != s.ctx || s.snapshots != 1 {
		s.t.Fatal("unexpected snapshot context or count")
	}
	err := op(s)
	if err != s.callbackWant {
		s.t.Fatalf("callback error = %v, want %v", err, s.callbackWant)
	}
	if s.completion != nil {
		return s.completion
	}
	return err
}
func (s *resolveSnapshot) ProjectDAO() store.ProjectReader {
	s.daoCalls++
	if s.daoCalls != 1 {
		s.t.Fatal("unexpected ProjectDAO call")
	}
	return s
}
func (s *resolveSnapshot) WriteProject(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.writes++
	s.t.Fatal("unexpected Project write")
	return store.Completion{}, nil
}
func (s *resolveSnapshot) WriteProjectCreation(context.Context, string, func(store.ProjectCreationDAO) error) (store.Completion, error) {
	s.writes++
	s.t.Fatal("unexpected Project creation")
	return store.Completion{}, nil
}

func TestResolveRepositorySnapshotAndFailures(t *testing.T) {
	first := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	queryErr := errors.New("query failed")
	completionErr := errors.New("snapshot completion failed")
	conflict := &model.Fault{Code: "resource_conflict", Message: "ambiguous repository"}
	invalid := &model.Fault{Code: "invalid_input", Message: "bad candidate"}
	for _, tc := range []struct {
		name                                         string
		result                                       model.Project
		found                                        bool
		operationErr, callbackErr, completion, cause error
		want                                         model.Project
		code                                         string
	}{
		{name: "missing", code: "not_found"},
		{name: "unique on later page", result: first, found: true, want: first},
		{name: "ambiguity on later page", operationErr: conflict, cause: conflict, code: "resource_conflict"},
		{name: "bad candidate", operationErr: invalid, cause: invalid, code: "invalid_input"},
		{name: "query after match", result: first, operationErr: queryErr, callbackErr: queryErr, cause: queryErr},
		{name: "cancellation after match", result: first, operationErr: context.Canceled, callbackErr: context.Canceled, cause: context.Canceled},
		{name: "completion after match", result: first, found: true, completion: completionErr, cause: completionErr},
		{name: "completion overrides refusal", result: first, operationErr: conflict, completion: completionErr, cause: completionErr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			fixture := &resolveSnapshot{t: t, ctx: ctx, callbackWant: tc.callbackErr, completion: tc.completion}
			subject := NewProjects(fixture)
			calls := 0
			expectedMatch, err := core.NewRepositoryMatch(resolveAddress)
			if err != nil {
				t.Fatal(err)
			}
			subject.findRepository = func(gotCtx context.Context, dao store.ProjectReader, principal model.Principal, match *core.RepositoryMatch) (model.Project, bool, error) {
				calls++
				if calls != 1 || gotCtx != ctx || dao != fixture || principal != resolvePrincipal || !reflect.DeepEqual(match, expectedMatch) {
					t.Fatalf("unexpected operation input: calls=%d ctx=%v dao=%T principal=%+v match=%+v", calls, gotCtx, dao, principal, match)
				}
				return tc.result, tc.found, tc.operationErr
			}
			got, err := subject.ResolveRepository(ctx, resolvePrincipal, resolveAddress)
			if tc.code != "" {
				resolveFault(t, err, tc.code)
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("error = %v, want %v", err, tc.cause)
			}
			if tc.code == "" && tc.cause == nil && err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) || fixture.snapshots != 1 || fixture.daoCalls != 1 || calls != 1 || fixture.writes != 0 {
				t.Fatalf("result=%+v snapshots=%d dao=%d operations=%d writes=%d", got, fixture.snapshots, fixture.daoCalls, calls, fixture.writes)
			}
		})
	}
}

func TestResolveRepositoryValidationBeforeSnapshot(t *testing.T) {
	t.Run("constructor binding", func(t *testing.T) {
		engine := session.NewEngine(nil)
		for _, subject := range []*Projects{NewProjects(nil), NewProjects(nil, engine)} {
			if subject.findRepository == nil || reflect.ValueOf(subject.findRepository).Pointer() != reflect.ValueOf(core.FindRepository).Pointer() {
				t.Fatal("constructor did not bind FindRepository")
			}
		}
		if NewProjects(nil, engine).engine != engine || NewProjects(nil).engine == nil || NewProjects(nil, nil).engine != nil {
			t.Fatal("constructor changed optional engine semantics")
		}
	})
	for _, tc := range []struct {
		principal     model.Principal
		address, code string
	}{
		{model.Principal{}, resolveAddress, "unauthenticated"}, {resolvePrincipal, "https://github.com/%2f", "invalid_input"},
	} {
		ctx := t.Context()
		fixture := &resolveSnapshot{t: t, ctx: ctx}
		subject := NewProjects(fixture)
		calls := 0
		subject.findRepository = func(context.Context, store.ProjectReader, model.Principal, *core.RepositoryMatch) (model.Project, bool, error) {
			calls++
			t.Fatal("validation called FindRepository")
			return model.Project{}, false, nil
		}
		got, err := subject.ResolveRepository(ctx, tc.principal, tc.address)
		resolveFault(t, err, tc.code)
		if !reflect.DeepEqual(got, model.Project{}) || fixture.snapshots != 0 || fixture.daoCalls != 0 || fixture.writes != 0 || calls != 0 {
			t.Fatalf("validation returned data or performed work: %+v", got)
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
