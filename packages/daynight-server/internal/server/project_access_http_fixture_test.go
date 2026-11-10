package server

import (
	"context"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type projectAccessHTTPFixture struct {
	t              *testing.T
	principal      model.Principal
	projects       *projectHTTPOperations
	teams          *teamHTTPOperations
	identity       *operationHTTPIdentity
	tasks          *taskHTTPOperations
	memberships    *projectHTTPMembershipOperations
	sync           func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error)
	handler        *resourceTestHandler
	requestContext context.Context
	authenticated  map[context.Context]bool
}

func newProjectAccessHTTPFixture(t *testing.T, principal model.Principal, output io.Writer) *projectAccessHTTPFixture {
	t.Helper()
	f := &projectAccessHTTPFixture{t: t, principal: principal, projects: newProjectHTTPOperations(t), teams: &teamHTTPOperations{t: t}, tasks: &taskHTTPOperations{t: t}, memberships: &projectHTTPMembershipOperations{t: t}}
	f.authenticated = make(map[context.Context]bool)
	f.identity = &operationHTTPIdentity{t: t}
	f.identity.CallbackURLFn = func() string { return configuredTestConfig().UniAuthCallbackURL }
	f.identity.AuthenticateFn = func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if f.authenticated[ctx] {
			unexpectedHTTPCall(t, "duplicate Authenticate for one request")
		}
		f.authenticated[ctx] = true
		f.requestContext = ctx
		projectHTTPCheck(t, kind, principal.Kind)
		projectHTTPCheck(t, token, httpTestToken(principal.Kind))
		if ctx.Err() != nil {
			t.Fatalf("authentication received canceled context: %v", ctx.Err())
		}
		return principal, nil
	}
	f.handler = newOperationHTTPServerWithIdentity(t, f.identity, func(deps *httpDependencies) {
		deps.Projects, deps.Memberships, deps.Tasks, deps.Teams = f.projects, f.memberships, f.tasks, f.teams
		deps.TaskSync = func(ctx context.Context, actor model.Principal, id string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
			if f.sync == nil {
				unexpectedHTTPCall(t, "TaskSync")
			}
			return f.sync(ctx, actor, id, input)
		}
	}, output, principal)
	return f
}

func (f *projectAccessHTTPFixture) require(ctx context.Context, actor, expected model.Principal, id, expectedID string) {
	f.t.Helper()
	requireOperationHTTPContext(f.t, ctx)
	if ctx != f.requestContext || ctx.Err() != nil {
		f.t.Fatalf("operation lost authenticated request context: %v", ctx.Err())
	}
	projectHTTPCheck(f.t, actor, expected)
	projectHTTPCheck(f.t, id, expectedID)
}

func accessHTTPProject(t *testing.T, f *projectAccessHTTPFixture, p model.Principal, v model.Project, access model.ProjectAccess, kind string, input taskservice.TaskSyncRequest, graphTask *model.GraphTask, syncMode ...string) {
	t.Helper()
	access = projectHTTPCopyAccess(access)
	input.Since = projectHTTPCopyPointer(input.Since)
	called := projectHTTPCount(t, 1)
	switch kind {
	case "access":
		f.projects.AccessCall = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
			called()
			f.require(ctx, actor, p, id, v.ID)
			return projectHTTPCopyAccess(access), nil
		}
	case "project":
		f.projects.GetWithAccessCall = func(ctx context.Context, actor model.Principal, id string) (model.Project, model.ProjectAccess, error) {
			called()
			f.require(ctx, actor, p, id, v.ID)
			return v, projectHTTPCopyAccess(access), nil
		}
	case "list":
		f.projects.ListScopedCall = func(ctx context.Context, actor model.Principal, got coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
			called()
			f.require(ctx, actor, p, "", "")
			projectHTTPCheck(t, got, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 50}})
			return coreproject.ProjectPage{Items: []model.Project{v}}, nil
		}
	case "members":
		f.memberships.ListWithAccessCall = func(ctx context.Context, actor model.Principal, id string) (coreproject.ProjectParticipants, error) {
			called()
			f.require(ctx, actor, p, id, v.ID)
			owner := access.OwnerTeam
			owner.Name = projectHTTPCopyPointer(owner.Name)
			return coreproject.ProjectParticipants{ActorAccess: projectHTTPCopyAccess(access), Items: []model.ProjectParticipant{{UserID: p.UserID, Profile: model.ProjectParticipantProfile{}, EffectiveRole: model.ProjectAdmin, InheritedFrom: &model.ProjectInheritance{Team: owner, Role: model.ProjectAdmin}}}}, nil
		}
	case "sync":
		f.sync = func(ctx context.Context, actor model.Principal, id string, got taskservice.TaskSyncRequest) (model.TaskSync, error) {
			called()
			f.require(ctx, actor, p, id, v.ID)
			projectHTTPCheck(t, got, input)
			if len(syncMode) != 1 {
				t.Fatal("sync requires one explicitly configured result mode")
			}
			mode := syncMode[0]
			return model.TaskSync{Mode: mode, Epoch: "e5555555-5555-4555-8555-555555555555", Project: v, ActorAccess: projectHTTPCopyAccess(access), ObservedAt: v.UpdatedAt, Tasks: []model.TaskViewRecord{}, AssigneeVersions: []model.TaskAssigneeVersion{}, Sessions: map[string]model.SessionListState{}}, nil
		}
	case "graph":
		row := projectHTTPCopyGraphTask(*graphTask)
		f.tasks.GraphCall = func(ctx context.Context, actor model.Principal, id, root string) (model.TaskGraph, error) {
			called()
			f.require(ctx, actor, p, id, v.ID)
			projectHTTPCheck(t, root, row.ID)
			return model.TaskGraph{Project: v, ObservedAt: v.UpdatedAt, Summary: model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}, Tasks: []model.GraphTask{projectHTTPCopyGraphTask(row)}}, nil
		}
	default:
		t.Fatalf("unknown access projection %q", kind)
	}
}

func accessHTTPRefusal(t *testing.T, f *projectAccessHTTPFixture, p model.Principal, id string, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	f.projects.AccessCall = func(ctx context.Context, actor model.Principal, got string) (model.ProjectAccess, error) {
		called()
		f.require(ctx, actor, p, got, id)
		return model.ProjectAccess{}, failure
	}
}

func accessHTTPUser(t *testing.T, f *projectAccessHTTPFixture, p model.Principal, expected model.User, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	expected.Email = projectHTTPCopyPointer(expected.Email)
	expected.EmailVerified = projectHTTPCopyPointer(expected.EmailVerified)
	expected.Name = projectHTTPCopyPointer(expected.Name)
	expected.AvatarURL = projectHTTPCopyPointer(expected.AvatarURL)
	expected.PersonalTeam.Name = projectHTTPCopyPointer(expected.PersonalTeam.Name)
	f.identity.UserFn = func(ctx context.Context, actor model.Principal) (model.User, error) {
		called()
		f.require(ctx, actor, p, "", "")
		value := expected
		value.Email = projectHTTPCopyPointer(value.Email)
		value.EmailVerified = projectHTTPCopyPointer(value.EmailVerified)
		value.Name = projectHTTPCopyPointer(value.Name)
		value.AvatarURL = projectHTTPCopyPointer(value.AvatarURL)
		value.PersonalTeam.Name = projectHTTPCopyPointer(value.PersonalTeam.Name)
		return value, failure
	}
}
