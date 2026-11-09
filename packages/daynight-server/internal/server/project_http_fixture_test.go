package server

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type projectHTTPReader struct {
	store.ProjectReader
	ProjectCall        func(context.Context, string) (model.Project, error)
	ProjectAccessCall  func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	ScopedProjectsCall func(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error)
}

func (d projectHTTPReader) Project(ctx context.Context, id string) (model.Project, error) {
	return d.ProjectCall(ctx, id)
}
func (d projectHTTPReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return d.ProjectAccessCall(ctx, p, id)
}
func (d projectHTTPReader) ScopedProjects(ctx context.Context, p model.Principal, s store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	return d.ScopedProjectsCall(ctx, p, s, page)
}

type projectHTTPSnapshot struct {
	store.SnapshotScope
	ProjectReader store.ProjectReader
}

func (s projectHTTPSnapshot) ProjectDAO() store.ProjectReader { return s.ProjectReader }

type projectHTTPCreateDAO struct {
	store.ProjectCreationDAO
	PersonalCall func(context.Context, bool) (store.PersonalTeamFacts, error)
	TeamCall     func(context.Context, string) (store.ProjectCreationTeam, error)
	MemberCall   func(context.Context, string) (bool, error)
	InsertCall   func(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error)
}

func (d projectHTTPCreateDAO) CreationPersonalTeam(ctx context.Context, create bool) (store.PersonalTeamFacts, error) {
	return d.PersonalCall(ctx, create)
}
func (d projectHTTPCreateDAO) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	return d.TeamCall(ctx, id)
}
func (d projectHTTPCreateDAO) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	return d.MemberCall(ctx, id)
}
func (d projectHTTPCreateDAO) InsertProject(ctx context.Context, id, name, repo, team string) (model.Project, model.ProjectAccess, error) {
	return d.InsertCall(ctx, id, name, repo, team)
}

func projectHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected Project DAO argument/result: got %#v, want %#v", got, want)
		panic("Project DAO contract violated")
	}
}
func projectHTTPCount(t *testing.T, want int) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != want {
			t.Errorf("Project DAO call count: got %d, want %d", calls, want)
		}
	})
	return func() {
		calls++
		if calls > want {
			t.Errorf("extra Project DAO call: %d > %d", calls, want)
			panic("extra Project DAO call")
		}
	}
}
func projectHTTPRead(t *testing.T, tx *httpTestStore, reader store.ProjectReader) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		called()
		return op(projectHTTPSnapshot{ProjectReader: reader})
	}
}
func projectHTTPRecord(id, name, repo, team string) model.Project {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Project{ID: id, Name: name, RepoURL: repo, CreatedAt: at, UpdatedAt: at, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, Ownership: model.ProjectOwnership{TeamID: team, Version: 1, UpdatedAt: at}}
}
func projectHTTPAccess(p model.Principal, v model.Project) model.ProjectAccess {
	role := model.ProjectAdmin
	grant := model.ProjectGrant{ProjectID: v.ID, UserID: p.UserID, Role: role, Version: 1, CreatedAt: v.CreatedAt, UpdatedAt: v.CreatedAt}
	return model.ProjectAccess{ProjectID: v.ID, UserID: p.UserID, Role: role, DirectGrant: &grant, OwnerTeam: model.TeamRef{ID: v.Ownership.TeamID, Kind: "personal"}, Ownership: v.Ownership, TeamRole: &role, CanTransfer: true}
}
func projectHTTPGet(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project) {
	t.Helper()
	access, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, id, v.ID)
		return projectHTTPAccess(p, v), nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		read()
		projectHTTPCheck(t, id, v.ID)
		return v, nil
	}})
}
func projectHTTPPage(t *testing.T, tx *httpTestStore, p model.Principal, scope store.ProjectScope, page store.Page, items []model.Project, more bool) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, gotScope store.ProjectScope, gotPage store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, gotScope, scope)
		projectHTTPCheck(t, gotPage, page)
		return store.ProjectPage{Items: slices.Clone(items), HasMore: more}, nil
	}})
}
func projectHTTPCreate(t *testing.T, tx *httpTestStore, p model.Principal, name, repo, team string, explicit bool) *model.Project {
	t.Helper()
	out := new(model.Project)
	writer, first, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := projectHTTPCreateDAO{InsertCall: func(ctx context.Context, id, gotName, gotRepo, gotTeam string) (model.Project, model.ProjectAccess, error) {
		insert()
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.Version() != 4 {
			t.Errorf("create did not allocate UUIDv4: %s %v", id, err)
			panic("invalid created Project ID")
		}
		projectHTTPCheck(t, gotName, name)
		projectHTTPCheck(t, gotRepo, repo)
		projectHTTPCheck(t, gotTeam, team)
		*out = projectHTTPRecord(id, name, repo, team)
		access := projectHTTPAccess(p, *out)
		if explicit {
			name := "Team"
			access.OwnerTeam = model.TeamRef{ID: team, Kind: "ordinary", Name: &name}
		}
		return *out, access, nil
	}}
	if explicit {
		member := projectHTTPCount(t, 1)
		dao.TeamCall = func(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
			first()
			projectHTTPCheck(t, id, team)
			return store.ProjectCreationTeam{ID: team}, nil
		}
		dao.MemberCall = func(ctx context.Context, id string) (bool, error) {
			member()
			projectHTTPCheck(t, id, team)
			return true, nil
		}
	} else {
		dao.PersonalCall = func(ctx context.Context, create bool) (store.PersonalTeamFacts, error) {
			first()
			projectHTTPCheck(t, create, true)
			return store.PersonalTeamFacts{ID: team, MemberCount: 1, OwnerAdminCount: 1}, nil
		}
	}
	tx.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, user, p.UserID)
		err := op(dao)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return out
}

const projectHTTPPersonalTeam = "d0000000-0000-4000-8000-000000000050"

func projectHTTPListScope(kind store.ProjectScopeKind, team string) store.ProjectScope {
	return store.ProjectScope{Kind: kind, TeamID: team}
}

func projectHTTPCopyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func projectHTTPCopyAccess(value model.ProjectAccess) model.ProjectAccess {
	value.DirectGrant = projectHTTPCopyPointer(value.DirectGrant)
	value.OwnerTeam.Name = projectHTTPCopyPointer(value.OwnerTeam.Name)
	value.TeamRole = projectHTTPCopyPointer(value.TeamRole)
	return value
}
func projectHTTPCopyTeam(value model.Team) model.Team {
	value.Name = projectHTTPCopyPointer(value.Name)
	return value
}
func projectHTTPCopyGraphTask(value model.GraphTask) model.GraphTask {
	value.DependsOn = slices.Clone(value.DependsOn)
	value.ExternalDependsOn = slices.Clone(value.ExternalDependsOn)
	value.BlockedBy = slices.Clone(value.BlockedBy)
	value.RequiredPlatform = projectHTTPCopyPointer(value.RequiredPlatform)
	value.AssignedTo = projectHTTPCopyPointer(value.AssignedTo)
	value.StartedAt = projectHTTPCopyPointer(value.StartedAt)
	value.CompletedAt = projectHTTPCopyPointer(value.CompletedAt)
	value.CancelledAt = projectHTTPCopyPointer(value.CancelledAt)
	return value
}
