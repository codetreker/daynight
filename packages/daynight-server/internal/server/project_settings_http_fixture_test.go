package server

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type settingsHTTPWriteDAO struct {
	store.ProjectWriteDAO
	access  func(context.Context, model.Principal) (model.ProjectAccess, error)
	project func(context.Context) (model.Project, error)
	update  func(context.Context, int32) (model.Project, error)
}

func (d settingsHTTPWriteDAO) ProjectAccess(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
	return d.access(ctx, actor)
}
func (d settingsHTTPWriteDAO) Project(ctx context.Context) (model.Project, error) {
	return d.project(ctx)
}
func (d settingsHTTPWriteDAO) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	return d.update(ctx, minutes)
}

type settingsHTTPWriteScope struct {
	store.ProjectWriteScope
	dao store.ProjectWriteDAO
}

func (s settingsHTTPWriteScope) ProjectDAO() store.ProjectWriteDAO { return s.dao }

func settingsHTTPWrite(t *testing.T, tx *httpTestStore, actor model.Principal, before model.Project, minutes int32, result *model.Project, role model.ProjectRole, accessError error) {
	t.Helper()
	writes, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	order := []string{"access"}
	if accessError == nil && role == model.ProjectAdmin {
		order = append(order, "project")
		if result != nil {
			order = append(order, "update")
		}
	}
	position := 0
	next := func(method string) {
		if position >= len(order) {
			t.Errorf("extra settings DAO call %s", method)
			panic("extra settings DAO call")
		}
		projectHTTPCheck(t, method, order[position])
		position++
	}
	t.Cleanup(func() { projectHTTPCheck(t, position, len(order)) })
	dao := settingsHTTPWriteDAO{access: func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		access()
		next("access")
		projectHTTPCheck(t, principal, actor)
		value := projectHTTPAccess(actor, before)
		value.Role = role
		value.DirectGrant.Role = role
		value.TeamRole = nil
		value.CanTransfer = false
		if role == model.ProjectAdmin {
			value.TeamRole = &role
			value.CanTransfer = true
		}
		return value, accessError
	}}
	if len(order) > 1 {
		read := projectHTTPCount(t, 1)
		dao.project = func(context.Context) (model.Project, error) { read(); next("project"); return before, nil }
	}
	if result != nil {
		updated := projectHTTPCount(t, 1)
		dao.update = func(ctx context.Context, got int32) (model.Project, error) {
			updated()
			next("update")
			projectHTTPCheck(t, got, minutes)
			return *result, nil
		}
	}
	tx.WriteProjectCall = func(ctx context.Context, id string, operation func(store.ProjectWriteScope) error) (store.Completion, error) {
		writes()
		projectHTTPCheck(t, id, before.ID)
		err := operation(settingsHTTPWriteScope{dao: dao})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

type settingsHTTPGraphReader struct {
	store.TaskReader
	presence func(context.Context, string, string) (store.TaskPresence, error)
	size     func(context.Context, string, string, store.TaskGraphSelection) (store.TaskGraphSize, error)
	tasks    func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
}

func (d settingsHTTPGraphReader) TaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	return d.presence(ctx, projectID, taskID)
}
func (d settingsHTTPGraphReader) TaskGraphProjectionSize(ctx context.Context, projectID, taskID string, selection store.TaskGraphSelection) (store.TaskGraphSize, error) {
	return d.size(ctx, projectID, taskID, selection)
}
func (d settingsHTTPGraphReader) TaskGraphTasks(ctx context.Context, projectID, taskID string, selection store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
	return d.tasks(ctx, projectID, taskID, selection, characters)
}

type settingsHTTPSnapshot struct {
	store.SnapshotScope
	project  store.ProjectReader
	task     store.TaskReader
	observed func(context.Context) (time.Time, error)
}

func (s settingsHTTPSnapshot) ProjectDAO() store.ProjectReader { return s.project }
func (s settingsHTTPSnapshot) TaskDAO() store.TaskReader       { return s.task }
func (s settingsHTTPSnapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	return s.observed(ctx)
}

func settingsHTTPGraph(t *testing.T, tx *httpTestStore, actor model.Principal, value model.Project, taskID string) {
	t.Helper()
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, IncludeExternalEdges: true, LiveOnly: true}
	calls := make([]string, 0, 6)
	want := []string{"access", "project", "presence", "size", "tasks", "observed"}
	next := func(method string) {
		if len(calls) >= len(want) {
			t.Errorf("extra settings graph DAO call %s", method)
			panic("extra settings graph DAO call")
		}
		projectHTTPCheck(t, method, want[len(calls)])
		calls = append(calls, method)
	}
	t.Cleanup(func() { projectHTTPCheck(t, calls, want) })
	check := func(projectID, root string) {
		projectHTTPCheck(t, projectID, value.ID)
		projectHTTPCheck(t, root, taskID)
	}
	reader := settingsHTTPGraphReader{
		presence: func(ctx context.Context, projectID, root string) (store.TaskPresence, error) {
			next("presence")
			check(projectID, root)
			return store.TaskPresence{Found: true}, nil
		},
		size: func(ctx context.Context, projectID, root string, got store.TaskGraphSelection) (store.TaskGraphSize, error) {
			next("size")
			check(projectID, root)
			projectHTTPCheck(t, got, selection)
			return store.TaskGraphSize{NodeCount: 1}, nil
		},
		tasks: func(ctx context.Context, projectID, root string, got store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
			next("tasks")
			check(projectID, root)
			projectHTTPCheck(t, got, selection)
			projectHTTPCheck(t, characters, projection.TitlePreviewCharacters)
			return []model.GraphTask{{ID: taskID, TitlePreview: "Settings context", Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: value.CreatedAt, UpdatedAt: value.CreatedAt}}, nil
		},
	}
	project := projectHTTPReader{
		ProjectAccessCall: func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
			next("access")
			projectHTTPCheck(t, principal, actor)
			projectHTTPCheck(t, id, value.ID)
			return projectHTTPAccess(actor, value), nil
		},
		ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
			next("project")
			projectHTTPCheck(t, id, value.ID)
			return value, nil
		},
	}
	read := projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, operation func(store.SnapshotScope) error) error {
		read()
		return operation(settingsHTTPSnapshot{project: project, task: reader, observed: func(context.Context) (time.Time, error) {
			next("observed")
			return value.UpdatedAt.Add(time.Minute), nil
		}})
	}
}

type settingsHTTPIdentityDAO struct {
	store.IdentityDAO
	authenticate func(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
}

func (d settingsHTTPIdentityDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	return d.authenticate(ctx, kind, hash, now)
}

type settingsHTTPIdentityScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s settingsHTTPIdentityScope) IdentityDAO() store.IdentityDAO { return s.dao }

func settingsHTTPAuthenticate(t *testing.T, tx *httpTestStore, kind model.CredentialKind, value string, principal model.Principal, err error) {
	t.Helper()
	write, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := settingsHTTPIdentityDAO{authenticate: func(ctx context.Context, gotKind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
		read()
		projectHTTPCheck(t, gotKind, kind)
		if !reflect.DeepEqual(hash, secret.Hash(value)) || now.IsZero() || now.Location() != time.UTC {
			t.Errorf("authentication arguments changed: %s %x %s", gotKind, hash, now)
			panic("invalid authentication arguments")
		}
		return principal, err
	}}
	tx.WriteIdentityCall = func(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
		write()
		failure := operation(settingsHTTPIdentityScope{dao: dao})
		return store.Completion{Outcome: store.TransactionCommitted}, failure
	}
}

func settingsHTTPProjectList(t *testing.T, tx *httpTestStore, actor model.Principal, first, second model.Project) {
	t.Helper()
	called := projectHTTPCount(t, 2)
	position := 0
	pages := []store.Page{{Limit: 1}, {Limit: 1, After: &store.Position{CreatedAt: first.CreatedAt, ID: first.ID}}}
	results := []store.ProjectPage{{Items: []model.Project{first}, HasMore: true}, {Items: []model.Project{second}, HasMore: false}}
	scope := store.ProjectScope{Kind: store.ProjectScopeAll, MaxItemBytes: coreproject.MaxPageResponseJSONBytes}
	projectHTTPRead(t, tx, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, gotScope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, p, actor)
		projectHTTPCheck(t, gotScope, scope)
		projectHTTPCheck(t, page, pages[position])
		result := results[position]
		result.Items = slices.Clone(result.Items)
		position++
		return result, nil
	}})
}
