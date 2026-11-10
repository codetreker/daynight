package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func projectHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected Project operation argument/result: got %#v, want %#v", got, want)
		panic("Project operation contract violated")
	}
}
func projectHTTPCount(t *testing.T, want int) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != want {
			t.Errorf("Project operation call count: got %d, want %d", calls, want)
		}
	})
	return func() {
		calls++
		if calls > want {
			t.Errorf("extra Project operation call: %d > %d", calls, want)
			panic("extra Project operation call")
		}
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

const projectHTTPPersonalTeam = "d0000000-0000-4000-8000-000000000050"

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

func projectHTTPContext(t *testing.T, ctx context.Context, got, want model.Principal) {
	t.Helper()
	requireOperationHTTPContext(t, ctx)
	projectHTTPCheck(t, got, want)
}

func projectHTTPGet(t *testing.T, operations *projectHTTPOperations, actor model.Principal, value model.Project) {
	projectHTTPGetResult(t, operations, actor, value.ID, value, projectHTTPAccess(actor, value), nil)
}
func projectHTTPGetResult(t *testing.T, operations *projectHTTPOperations, actor model.Principal, id string, value model.Project, access model.ProjectAccess, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	access = projectHTTPCopyAccess(access)
	operations.GetWithAccessCall = func(ctx context.Context, p model.Principal, got string) (model.Project, model.ProjectAccess, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, id)
		return value, projectHTTPCopyAccess(access), failure
	}
}
func projectHTTPPage(t *testing.T, operations *projectHTTPOperations, actor model.Principal, input coreproject.ProjectListRequest, items []model.Project, next *string) {
	projectHTTPPageResult(t, operations, actor, input, items, next, nil)
}
func projectHTTPPageResult(t *testing.T, operations *projectHTTPOperations, actor model.Principal, input coreproject.ProjectListRequest, items []model.Project, next *string, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	input.TeamID = projectHTTPCopyPointer(input.TeamID)
	input.Page.Cursor = projectHTTPCopyPointer(input.Page.Cursor)
	items, next = slices.Clone(items), projectHTTPCopyPointer(next)
	operations.ListScopedCall = func(ctx context.Context, p model.Principal, got coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, input)
		return coreproject.ProjectPage{Items: slices.Clone(items), NextCursor: projectHTTPCopyPointer(next)}, failure
	}
}
func projectHTTPCreate(t *testing.T, operations *projectHTTPOperations, actor model.Principal, name, repo, team string, explicit bool) *model.Project {
	t.Helper()
	value := projectHTTPRecord("ab100000-0000-4000-8000-000000000001", name, repo, team)
	access := projectHTTPAccess(actor, value)
	var teamID *string
	if explicit {
		teamID = &team
		teamName := "Team"
		access.OwnerTeam = model.TeamRef{ID: team, Kind: "ordinary", Name: &teamName}
	}
	input := coreproject.CreateProject{Name: name, RepoURL: repo, TeamID: teamID, ExpectedUserID: actor.UserID}
	projectHTTPCreateResult(t, operations, actor, input, value, access, nil)
	return &value
}
func projectHTTPCreateResult(t *testing.T, operations *projectHTTPOperations, actor model.Principal, input coreproject.CreateProject, value model.Project, access model.ProjectAccess, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	input.TeamID = projectHTTPCopyPointer(input.TeamID)
	access = projectHTTPCopyAccess(access)
	operations.CreateWithAccessCall = func(ctx context.Context, p model.Principal, got coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, input)
		return value, projectHTTPCopyAccess(access), failure
	}
}
func projectHTTPListInput(limit int, cursor *string, team *string, shared bool) coreproject.ProjectListRequest {
	return coreproject.ProjectListRequest{Page: model.PageRequest{Limit: limit, Cursor: projectHTTPCopyPointer(cursor)}, TeamID: projectHTTPCopyPointer(team), Shared: shared}
}
func projectHTTPTestCursor(t *testing.T, actor model.Principal, scope, team string, value model.Project) *string {
	t.Helper()
	raw, err := json.Marshal(struct {
		Version   int       `json:"version"`
		Kind      string    `json:"kind"`
		UserID    string    `json:"userId"`
		Scope     string    `json:"scope"`
		TeamID    string    `json:"teamId"`
		CreatedAt time.Time `json:"createdAt"`
		ID        string    `json:"id"`
	}{2, "scoped-projects", actor.UserID, scope, team, value.CreatedAt.UTC(), value.ID})
	if err != nil {
		t.Fatal(err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(raw)
	return &cursor
}

func projectHTTPFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func projectHTTPListRefusal(t *testing.T, operations *projectHTTPOperations, actor model.Principal, input coreproject.ProjectListRequest) {
	projectHTTPPageResult(t, operations, actor, input, nil, nil, projectHTTPFault("invalid_input", "Cursor is invalid for this list."))
}
