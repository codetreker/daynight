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

var registrationPrincipal = model.Principal{Kind: model.SessionCredential, UserID: "55555555-5555-4555-8555-555555555555", CredentialID: "66666666-6666-4666-8666-666666666666"}

const registrationTeam = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type repositoryCreationPlan struct {
	*completionProjectReadPlan
	store.ProjectCreationDAO
	actor           model.Principal
	input           core.CreateProject
	teamID          string
	identity        string
	snapshotDone    bool
	completionFact  store.Completion
	completionErr   error
	writeSteps      []string
	writes, inserts int
	created         model.Project
}

func (f *repositoryCreationPlan) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	err := f.completionProjectReadPlan.ReadSnapshot(ctx, op)
	f.snapshotDone = err == nil
	return err
}

func (f *repositoryCreationPlan) WriteProjectCreation(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
	f.writes++
	if f.writes != 1 || len(f.writeSteps) == 0 || ctx != f.ctx || user != f.actor.UserID || !f.snapshotDone || len(f.pending) != 0 {
		f.t.Fatalf("unexpected creation after snapshot: writes=%d user=%s pending=%v completion=%v", f.writes, user, f.pending, f.completion)
	}
	if err := op(f); err != nil {
		f.t.Fatalf("creation callback failed: %v", err)
	}
	if len(f.writeSteps) != 0 {
		f.t.Fatalf("creation callback omitted %v", f.writeSteps)
	}
	return f.completionFact, f.completionErr
}

func (f *repositoryCreationPlan) expectCreationStep(ctx context.Context, step, teamID string) {
	f.t.Helper()
	if ctx != f.ctx || len(f.writeSteps) == 0 || f.writeSteps[0] != step || teamID != f.teamID {
		f.t.Fatalf("unexpected creation step %s for Team %s, pending=%v", step, teamID, f.writeSteps)
	}
	f.writeSteps = f.writeSteps[1:]
}

func (f *repositoryCreationPlan) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	f.expectCreationStep(ctx, "lock Team", id)
	return store.ProjectCreationTeam{ID: id}, nil
}

func (f *repositoryCreationPlan) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	f.expectCreationStep(ctx, "read membership", id)
	return true, nil
}

func (f *repositoryCreationPlan) RepositoryOccupied(ctx context.Context, teamID, identity string) (bool, error) {
	f.expectCreationStep(ctx, "check occupancy", teamID)
	if identity != f.identity {
		f.t.Fatalf("occupancy identity = %q, want %q", identity, f.identity)
	}
	return false, nil
}

func (f *repositoryCreationPlan) InsertProject(ctx context.Context, id, name, address, identity, teamID string) (model.Project, model.ProjectAccess, error) {
	f.expectCreationStep(ctx, "insert Project", teamID)
	f.inserts++
	if uuid.Validate(id) != nil || name != f.input.Name || address != f.input.RepoURL || identity != f.identity {
		f.t.Fatalf("unexpected insertion: id=%q name=%q address=%q identity=%q", id, name, address, identity)
	}
	f.created = model.Project{
		ID: id, Name: name, RepoURL: address,
		CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		Ownership: model.ProjectOwnership{TeamID: teamID, Version: 1},
	}
	return f.created, model.ProjectAccess{}, nil
}

func resolveCandidate(id, address string) model.Project {
	return model.Project{ID: id, Name: "Existing", RepoURL: address, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
}
func resolveCall(page store.Page, result store.ProjectPage, err error) completionProjectReadCall {
	return completionProjectReadCall{name: "scoped", args: []any{resolvePrincipal, store.ProjectScope{Kind: store.ProjectScopeAll}, page}, result: result, err: err}
}
func creationMatchCall(principal model.Principal, teamID, identity string, items []model.Project, err error) completionProjectReadCall {
	return completionProjectReadCall{name: "creation matches", args: []any{principal, teamID, identity}, result: items, err: err}
}
func (s *completionProjectReadPlan) FindVisibleRepositoryForCreation(ctx context.Context, principal model.Principal, teamID, identity string) ([]model.Project, error) {
	call := s.take(ctx, "creation matches", principal, teamID, identity)
	if call.result == nil {
		return nil, call.err
	}
	items, ok := call.result.([]model.Project)
	if !ok {
		s.t.Fatal("creation match read requires explicit result facts")
	}
	return items, call.err
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
	const githubIdentity = "github.com/Org/Repo"
	const ipv6Identity = "[::1]/repo"
	patProject := resolveCandidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "git@github.com:Org/Repo.git")
	githubProject := resolveCandidate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "https://GitHub.com/Org/Repo.git")
	githubProject.Ownership = model.ProjectOwnership{TeamID: registrationTeam, Version: 1}
	ipv6Project := resolveCandidate("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "ssh://git@::1:22/repo")
	ipv6Project.Ownership = githubProject.Ownership
	for _, tc := range []struct {
		name      string
		principal model.Principal
		team      string
		address   string
		identity  string
		items     []model.Project
		confirm   bool
		code      string
		create    bool
	}{
		{"PAT reuse without confirmation", resolvePrincipal, resolveTeam, resolveAddress, githubIdentity, []model.Project{patProject}, false, "", false},
		{"PAT reject unconfirmed creation", resolvePrincipal, resolveTeam, resolveAddress, githubIdentity, nil, false, "invalid_input", false},
		{"PAT confirmed creation", resolvePrincipal, resolveTeam, resolveAddress, githubIdentity, nil, true, "", true},
		{"PAT reject ambiguous even when confirmed", resolvePrincipal, resolveTeam, resolveAddress, githubIdentity, []model.Project{patProject, patProject}, true, "resource_conflict", false},
		{"Session reject unconfirmed creation", registrationPrincipal, registrationTeam, githubProject.RepoURL, githubIdentity, nil, false, "invalid_input", false},
		{"Session confirmed creation", registrationPrincipal, registrationTeam, githubProject.RepoURL, githubIdentity, nil, true, "", true},
		{"Session reuse HTTPS", registrationPrincipal, registrationTeam, githubProject.RepoURL, githubIdentity, []model.Project{githubProject}, false, "", false},
		{"Session reuse SCP", registrationPrincipal, registrationTeam, "git@github.com:Org/Repo.git", githubIdentity, []model.Project{githubProject}, false, "", false},
		{"Session reuse SSH with default port", registrationPrincipal, registrationTeam, "ssh://git@github.com:22/Org/Repo.git", githubIdentity, []model.Project{githubProject}, false, "", false},
		{"Session reject distinct relative path", registrationPrincipal, registrationTeam, "git@github.com:./Org/Repo.git", "scp://git@github.com:./Org/Repo", nil, false, "invalid_input", false},
		{"Session reject distinct SSH port", registrationPrincipal, registrationTeam, "ssh://git@github.com:2222/Org/Repo.git", "ssh://git@github.com:2222/Org/Repo", nil, false, "invalid_input", false},
		{"Session reject distinct path case", registrationPrincipal, registrationTeam, "https://github.com/org/Repo.git", "github.com/org/Repo", nil, false, "invalid_input", false},
		{"Session create unbracketed IPv6", registrationPrincipal, registrationTeam, ipv6Project.RepoURL, ipv6Identity, nil, true, "", true},
		{"Session reuse bracketed IPv6", registrationPrincipal, registrationTeam, "https://[::1]/repo", ipv6Identity, []model.Project{ipv6Project}, false, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			team := tc.team
			input := core.CreateProject{Name: "Repository", RepoURL: tc.address, TeamID: &team, ExpectedUserID: tc.principal.UserID}
			plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{creationMatchCall(tc.principal, tc.team, tc.identity, tc.items, nil)})
			fixture := &repositoryCreationPlan{completionProjectReadPlan: plan, actor: tc.principal, input: input, teamID: tc.team, identity: tc.identity}
			if tc.create {
				fixture.writeSteps = []string{"lock Team", "read membership", "check occupancy", "insert Project"}
				fixture.completionFact = store.Completion{Outcome: store.TransactionCommitted}
			}
			got, created, err := NewProjects(fixture).RegisterRepository(ctx, tc.principal, input, tc.confirm)
			if tc.code != "" {
				resolveFault(t, err, tc.code)
				if tc.code == "invalid_input" && err.Error() != "Project creation requires confirmation." {
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
			} else if len(tc.items) == 1 {
				want = tc.items[0]
			}
			if got != want || created != tc.create || fixture.writes != writes || fixture.inserts != writes {
				t.Fatalf("result=%+v created=%v writes=%d inserts=%d", got, created, fixture.writes, fixture.inserts)
			}
		})
	}
}

func TestRegisterRepositoryDoesNotReturnUnconfirmedCreation(t *testing.T) {
	principal := registrationPrincipal
	team := registrationTeam
	input := core.CreateProject{Name: "Repository", RepoURL: "https://GitHub.com/Org/Repo.git", TeamID: &team, ExpectedUserID: principal.UserID}
	const identity = "github.com/Org/Repo"
	cause := errors.New("commit response lost")
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		err     error
	}{
		{"not committed", store.TransactionNotCommitted, nil},
		{"unknown", store.TransactionUnknown, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{creationMatchCall(principal, team, identity, nil, nil)})
			fixture := &repositoryCreationPlan{
				completionProjectReadPlan: plan, actor: principal, input: input, teamID: registrationTeam, identity: identity,
				writeSteps:     []string{"lock Team", "read membership", "check occupancy", "insert Project"},
				completionFact: store.Completion{Outcome: tc.outcome}, completionErr: tc.err,
			}
			got, created, err := NewProjects(fixture).RegisterRepository(ctx, principal, input, true)
			var fault *model.Fault
			if err == nil || errors.As(err, &fault) || got != (model.Project{}) || created || fixture.writes != 1 || fixture.inserts != 1 {
				t.Fatalf("unconfirmed creation returned: result=%+v created=%v writes=%d inserts=%d error=%v", got, created, fixture.writes, fixture.inserts, err)
			}
			if tc.err != nil && (!errors.Is(err, tc.err) || !errors.Is(err, cause)) {
				t.Fatalf("creation lost completion error: %v", err)
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
		plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{creationMatchCall(resolvePrincipal, resolveTeam, "github.com/Org/Repo", items, nil)})
		plan.completion = failure
		fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
		got, created, err := NewProjects(fixture).RegisterRepository(ctx, resolvePrincipal, input, true)
		if !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Project{}) || created || fixture.writes != 0 {
			t.Fatalf("result=%+v created=%v error=%v writes=%d", got, created, err, fixture.writes)
		}
	}
}

func TestRegisterRepositoryDoesNotCreateAfterMatchQueryFailure(t *testing.T) {
	team := resolveTeam
	input := core.CreateProject{Name: "Repository", RepoURL: resolveAddress, TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}
	failure := errors.New("match query failed")
	ctx := t.Context()
	plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{creationMatchCall(resolvePrincipal, resolveTeam, "github.com/Org/Repo", nil, failure)})
	plan.callbackErr = failure
	fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
	got, created, err := NewProjects(fixture).RegisterRepository(ctx, resolvePrincipal, input, true)
	if !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Project{}) || created || fixture.writes != 0 {
		t.Fatalf("result=%+v created=%v error=%v writes=%d", got, created, err, fixture.writes)
	}
}
