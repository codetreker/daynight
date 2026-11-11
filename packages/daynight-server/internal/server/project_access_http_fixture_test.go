package server

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

type accessHTTPProjectReader struct {
	projectHTTPReader
	participants func(context.Context, string) ([]model.ProjectParticipant, error)
}

func (d accessHTTPProjectReader) ProjectParticipants(ctx context.Context, id string) ([]model.ProjectParticipant, error) {
	return d.participants(ctx, id)
}

type accessHTTPSnapshot struct {
	store.SnapshotScope
	project  store.ProjectReader
	task     store.TaskReader
	session  store.SessionReader
	observed func(context.Context) (time.Time, error)
}

func (s accessHTTPSnapshot) ProjectDAO() store.ProjectReader { return s.project }
func (s accessHTTPSnapshot) TaskDAO() store.TaskReader       { return s.task }
func (s accessHTTPSnapshot) SessionDAO() store.SessionReader { return s.session }
func (s accessHTTPSnapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	return s.observed(ctx)
}

type accessHTTPTaskReader struct {
	store.TaskReader
	epoch        func(context.Context, string) (string, error)
	sync         func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	dependencies func(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
	people       func(context.Context, string) ([]model.TaskAssigneeFact, error)
	presence     func(context.Context, string, string) (store.TaskPresence, error)
	graph        func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
}

func (d accessHTTPTaskReader) TaskCacheEpoch(ctx context.Context, id string) (string, error) {
	return d.epoch(ctx, id)
}
func (d accessHTTPTaskReader) TaskSyncTasks(ctx context.Context, id string, lower *time.Time, preview int) ([]model.TaskViewRecord, error) {
	return d.sync(ctx, id, lower, preview)
}
func (d accessHTTPTaskReader) TaskSyncDependencyStates(ctx context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
	return d.dependencies(ctx, id, lower)
}
func (d accessHTTPTaskReader) TaskAssignees(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
	return d.people(ctx, id)
}
func (d accessHTTPTaskReader) TaskPresence(ctx context.Context, project, id string) (store.TaskPresence, error) {
	return d.presence(ctx, project, id)
}
func (d accessHTTPTaskReader) TaskGraphTasks(ctx context.Context, project, id string, selection store.TaskGraphSelection, preview int) ([]model.GraphTask, error) {
	return d.graph(ctx, project, id, selection, preview)
}

type accessHTTPSessionReader struct {
	store.SessionReader
	sources func(context.Context, string) ([]store.TaskSessionSource, error)
}

func (d accessHTTPSessionReader) CurrentTaskSessionSources(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
	return d.sources(ctx, id)
}

type accessHTTPIdentityUserDAO struct {
	httpRejectedIdentityDAO
	user func(context.Context, string) (model.User, store.PersonalTeamFacts, error)
}

func (d accessHTTPIdentityUserDAO) IdentityUser(ctx context.Context, id string) (model.User, store.PersonalTeamFacts, error) {
	return d.user(ctx, id)
}

func accessHTTPProject(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project, access model.ProjectAccess, kind string, lower *time.Time, graphTask *model.GraphTask) {
	t.Helper()
	access = projectHTTPCopyAccess(access)
	lower = projectHTTPCopyPointer(lower)
	if graphTask != nil {
		facts := projectHTTPCopyGraphTask(*graphTask)
		graphTask = &facts
	}
	snapshotCalls := projectHTTPCount(t, 1)
	reader := accessHTTPProjectReader{}
	if kind != "list" {
		calls := projectHTTPCount(t, 1)
		reader.ProjectAccessCall = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
			calls()
			projectHTTPCheck(t, actor, p)
			projectHTTPCheck(t, id, v.ID)
			return projectHTTPCopyAccess(access), nil
		}
	}
	if kind == "project" || kind == "sync" || kind == "graph" {
		calls := projectHTTPCount(t, 1)
		reader.ProjectCall = func(ctx context.Context, id string) (model.Project, error) {
			calls()
			projectHTTPCheck(t, id, v.ID)
			return v, nil
		}
	}
	if kind == "list" {
		calls := projectHTTPCount(t, 1)
		reader.ScopedProjectsCall = func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
			calls()
			projectHTTPCheck(t, actor, p)
			projectHTTPCheck(t, scope, projectHTTPListScope(store.ProjectScopeAll, ""))
			projectHTTPCheck(t, page, store.Page{Limit: 50})
			return store.ProjectPage{Items: []model.Project{v}}, nil
		}
	}
	if kind == "members" {
		calls := projectHTTPCount(t, 1)
		reader.participants = func(ctx context.Context, id string) ([]model.ProjectParticipant, error) {
			calls()
			projectHTTPCheck(t, id, v.ID)
			owner := access.OwnerTeam
			owner.Name = projectHTTPCopyPointer(owner.Name)
			return []model.ProjectParticipant{{UserID: p.UserID, Profile: model.ProjectParticipantProfile{}, EffectiveRole: model.ProjectAdmin, InheritedFrom: &model.ProjectInheritance{Team: owner, Role: model.ProjectAdmin}}}, nil
		}
	}
	snapshot := accessHTTPSnapshot{project: reader}
	if kind == "sync" || kind == "graph" {
		observed := projectHTTPCount(t, 1)
		snapshot.observed = func(context.Context) (time.Time, error) { observed(); return v.UpdatedAt, nil }
	}
	if kind == "sync" {
		epoch, sync, dependencies, people, sources := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		snapshot.task = accessHTTPTaskReader{
			epoch: func(ctx context.Context, id string) (string, error) {
				epoch()
				projectHTTPCheck(t, id, v.ID)
				return "e5555555-5555-4555-8555-555555555555", nil
			},
			sync: func(ctx context.Context, id string, gotLower *time.Time, preview int) ([]model.TaskViewRecord, error) {
				sync()
				projectHTTPCheck(t, id, v.ID)
				projectHTTPCheck(t, gotLower, lower)
				projectHTTPCheck(t, preview, projection.TitlePreviewCharacters)
				return []model.TaskViewRecord{}, nil
			},
			dependencies: func(ctx context.Context, id string, gotLower *time.Time) (map[string]model.TaskDependencyState, error) {
				dependencies()
				projectHTTPCheck(t, id, v.ID)
				projectHTTPCheck(t, gotLower, lower)
				return map[string]model.TaskDependencyState{}, nil
			},
			people: func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
				people()
				projectHTTPCheck(t, id, v.ID)
				return []model.TaskAssigneeFact{}, nil
			},
		}
		snapshot.session = accessHTTPSessionReader{sources: func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
			sources()
			projectHTTPCheck(t, id, v.ID)
			return []store.TaskSessionSource{}, nil
		}}
	}
	if kind == "graph" {
		presence, tasks := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
		snapshot.task = accessHTTPTaskReader{
			presence: func(ctx context.Context, project, id string) (store.TaskPresence, error) {
				presence()
				projectHTTPCheck(t, project, v.ID)
				projectHTTPCheck(t, id, graphTask.ID)
				return store.TaskPresence{Found: true}, nil
			},
			graph: func(ctx context.Context, project, id string, gotSelection store.TaskGraphSelection, preview int) ([]model.GraphTask, error) {
				tasks()
				projectHTTPCheck(t, project, v.ID)
				projectHTTPCheck(t, id, graphTask.ID)
				projectHTTPCheck(t, gotSelection, selection)
				projectHTTPCheck(t, preview, projection.TitlePreviewCharacters)
				return []model.GraphTask{projectHTTPCopyGraphTask(*graphTask)}, nil
			},
		}
	}
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshotCalls()
		return op(snapshot)
	}
}
func accessHTTPRefusal(t *testing.T, tx *httpTestStore, p model.Principal, id string, err error) {
	t.Helper()
	snapshot, called := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(accessHTTPSnapshot{project: projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
			called()
			projectHTTPCheck(t, actor, p)
			projectHTTPCheck(t, project, id)
			return model.ProjectAccess{}, err
		}}})
	}
}
func accessHTTPUser(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project, facts store.PersonalTeamFacts) {
	t.Helper()
	authentication := newHTTPTestStoreForPrincipal(t, p).WriteIdentityCall
	write, user := projectHTTPCount(t, 2), projectHTTPCount(t, 1)
	phase := 0
	tx.WriteIdentityCall = func(ctx context.Context, op func(store.IdentityScope) error) (store.Completion, error) {
		write()
		phase++
		if phase == 1 {
			return authentication(ctx, op)
		}
		dao := accessHTTPIdentityUserDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, user: func(ctx context.Context, id string) (model.User, store.PersonalTeamFacts, error) {
			user()
			projectHTTPCheck(t, id, p.UserID)
			return model.User{ID: p.UserID, UniAuthID: "fixture-owner", CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}, facts, nil
		}}
		err := op(httpAuthenticationScope{t: t, dao: dao})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}
