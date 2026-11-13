package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func projectTestHandler(t *testing.T, database store.Transactions, output io.Writer) *resourceTestHandler {
	t.Helper()
	return resourceTestServer(t, database, attachmentTestFiles(t), output)
}

func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

func TestRootUnknownPathUsesApplicationFallback(t *testing.T) {
	database := newHTTPTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/unknown-secret-path?query=secret", ""), http.StatusNotFound, "not_found")
}

func TestPublicHealthAndReadinessUseConfiguredProbe(t *testing.T) {
	database := newHTTPTestStore(t)
	ready := true
	readyCalls := 0
	application, err := newTestHandler(Dependencies{Store: database, Files: attachmentTestFiles(t), Ready: func(ctx context.Context) error {
		readyCalls++
		if !ready {
			return &store.Error{Phase: "ping", DatabaseFailure: true, Cause: errors.New("private-health-project database unavailable")}
		}
		return nil
	}}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.(*sessionApplication).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	handler := &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), application), token: defaultHTTPToken(), principal: defaultHTTPPrincipal()}
	request := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	assertProjectError(t, request(http.MethodGet, "/api/v1/projects"), http.StatusUnauthorized, "unauthenticated")
	for path, status := range map[string]string{"/healthz": "ok", "/readyz": "ready"} {
		response := request(http.MethodGet, path)
		value := decodeResponse[map[string]string](t, response, http.StatusOK)
		if len(value) != 1 || value["status"] != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("health response exposed data or cached state: %s %+v", response.Body, response.Header())
		}
		unsupported := request(http.MethodPost, path)
		assertProjectError(t, unsupported, http.StatusMethodNotAllowed, "method_not_allowed")
		if unsupported.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("health method boundary: %+v", unsupported.Header())
		}
	}
	ready = false
	response := request(http.MethodGet, "/readyz")
	assertProjectError(t, response, http.StatusServiceUnavailable, "service_unavailable")
	if strings.Contains(response.Body.String(), "private-health-project") || strings.Contains(response.Body.String(), "database") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness failure exposed data or cached state: %s %+v", response.Body, response.Header())
	}
	decodeResponse[map[string]string](t, request(http.MethodGet, "/healthz"), http.StatusOK)
	if readyCalls != 2 {
		t.Fatalf("readiness callback calls: %d", readyCalls)
	}
}

func TestAccessAndEmptySyncActorProjection(t *testing.T) {
	admin := defaultHTTPPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	project := projectHTTPRecord("a8888888-8888-4888-8888-888888888888", "Access projection", "https://example.test/access.git", "b9999999-9999-4999-8999-999999999999")
	var logs bytes.Buffer
	adminTx := newHTTPTestStoreForPrincipal(t, admin)
	adminHandler := resourceTestServerForPrincipal(t, adminTx, attachmentTestFiles(t), &logs, admin)
	path := "/api/v1/projects/" + strings.ToUpper(project.ID) + "/access"
	for _, test := range []struct {
		principal model.Principal
		role      model.ProjectRole
		version   int64
	}{
		{admin, model.ProjectAdmin, 9007199254740993}, {member, model.ProjectMemberRole, 1},
	} {
		tx, handler := adminTx, adminHandler
		if test.principal != admin {
			tx = newHTTPTestStoreForPrincipal(t, test.principal)
			handler = resourceTestServerForPrincipal(t, tx, attachmentTestFiles(t), &logs, test.principal)
		}
		expected := projectHTTPAccess(test.principal, project)
		expected.Role = test.role
		expected.DirectGrant.Role = test.role
		expected.DirectGrant.Version = test.version
		if test.role != model.ProjectAdmin {
			expected.TeamRole = nil
			expected.CanTransfer = false
		}
		accessHTTPProject(t, tx, test.principal, project, expected, "access", nil, nil)
		response := projectRequest(handler, http.MethodGet, path, "")
		access := decodeResponse[api.ProjectAccess](t, response, http.StatusOK)
		grant := access.DirectGrant
		if access.EffectiveRole != string(test.role) || grant == nil || grant.Role != string(test.role) || grant.UserID != test.principal.UserID || grant.ProjectID != project.ID || grant.Version != test.version || grant.CreatedAt.IsZero() || grant.UpdatedAt.IsZero() || grant.CreatedAt.Location() != time.UTC || grant.UpdatedAt.Location() != time.UTC {
			t.Fatalf("actor access: %#v", access)
		}
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != test.principal.UserID {
			t.Fatalf("access cache/identity: %#v", response.Header())
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 7 || fields["effectiveRole"] == nil || fields["directGrant"] == nil {
			t.Fatalf("access envelope: %s %v", response.Body, err)
		}
		var direct map[string]json.RawMessage
		if err := json.Unmarshal(fields["directGrant"], &direct); err != nil || len(direct) != 6 {
			t.Fatalf("profile-free grant: %#v %v", direct, err)
		}
		for _, key := range []string{"projectId", "userId", "role", "version", "createdAt", "updatedAt"} {
			if direct[key] == nil {
				t.Fatalf("missing grant field %s: %#v", key, direct)
			}
		}
		if test.role == model.ProjectAdmin && string(direct["version"]) != "9007199254740993" {
			t.Fatalf("grant version lost precision or number representation: %s", direct["version"])
		}
		accessHTTPProject(t, tx, test.principal, project, expected, "sync", nil, nil)
		snapshot := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
		since := time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC).Add(-10 * time.Second)
		accessHTTPProject(t, tx, test.principal, project, expected, "sync", &since, nil)
		deltaResponse := projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", "")
		delta := decodeResponse[api.TaskSync](t, deltaResponse, http.StatusOK)
		if !reflect.DeepEqual(snapshot.ActorAccess, access) || !reflect.DeepEqual(delta.ActorAccess, access) || delta.Mode != "delta" || delta.Tasks == nil || len(delta.Tasks) != 0 || !strings.Contains(deltaResponse.Body.String(), `"actorAccess":`) {
			t.Fatalf("actor projection missing from empty sync: %#v %#v", snapshot, delta)
		}
	}
}

func TestOwnershipProjectionExactVersionsAcrossCurrentReaders(t *testing.T) {
	actor := defaultHTTPPrincipal()
	tx := newHTTPTestStoreForPrincipal(t, actor)
	var logs bytes.Buffer
	handler := resourceTestServerForPrincipal(t, tx, attachmentTestFiles(t), &logs, actor)
	project := projectHTTPRecord("a8888888-8888-4888-8888-888888888888", "Ownership projection", "https://example.test/ownership.git", "b9999999-9999-4999-8999-999999999999")
	project.Ownership.Version = 9007199254740993
	expected := projectHTTPAccess(actor, project)
	facts := store.PersonalTeamFacts{ID: project.Ownership.TeamID, MemberCount: 1, OwnerAdminCount: 1}
	accessHTTPUser(t, tx, actor, project, facts)
	me := decodeResponse[api.User](t, projectRequest(handler, "GET", "/api/v1/me", ""), 200)
	tx.WriteIdentityCall = newHTTPTestStoreForPrincipal(t, actor).WriteIdentityCall
	if me.PersonalTeam.ID != project.Ownership.TeamID || me.PersonalTeam.Kind != "personal" || me.PersonalTeam.Name != nil {
		t.Fatalf("Personal reference: %#v", me)
	}
	base := "/api/v1/projects/" + project.ID
	accessHTTPProject(t, tx, actor, project, expected, "project", nil, nil)
	response := projectRequest(handler, "GET", base, "")
	document := decodeResponse[api.ProjectDocument](t, response, 200)
	if document.Ownership.TeamID != me.PersonalTeam.ID || document.Ownership.Version != 9007199254740993 || document.Access.Ownership != document.Ownership || document.Access.OwnerTeam != me.PersonalTeam || document.Access.TeamRole == nil || *document.Access.TeamRole != "admin" || !document.Access.CanTransfer || !strings.Contains(response.Body.String(), `"version":9007199254740993`) {
		t.Fatalf("Project ownership/access: %s", response.Body)
	}
	accessHTTPProject(t, tx, actor, project, expected, "list", nil, nil)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, "GET", "/api/v1/projects", ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "sync", nil, nil)
	snapshot := decodeResponse[api.TaskSync](t, projectRequest(handler, "GET", base+"/task-sync", ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "sync", nil, nil)
	delta := decodeResponse[api.TaskSync](t, projectRequest(handler, "GET", base+"/task-sync?epoch="+snapshot.Epoch, ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "members", nil, nil)
	people := decodeResponse[api.ProjectParticipantList](t, projectRequest(handler, "GET", base+"/members", ""), 200)
	if len(page.Items) != 1 || page.Items[0] != document.Project || snapshot.Project != document.Project || delta.Project != document.Project || !reflect.DeepEqual(snapshot.ActorAccess, document.Access) || !reflect.DeepEqual(people.ActorAccess, document.Access) || len(people.Items) != 1 || people.Items[0].InheritedFrom == nil || people.Items[0].InheritedFrom.Team != me.PersonalTeam || people.Items[0].InheritedFrom.Role != "admin" {
		t.Fatalf("current-reader divergence: %#v %#v %#v %#v", page, snapshot, delta, people)
	}
	task := model.GraphTask{ID: "caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TitlePreview: "Ownership graph", Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
	accessHTTPProject(t, tx, actor, project, expected, "graph", nil, &task)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, "GET", graphPath(project.ID, task.ID), ""), 200)
	if graph.Project != document.Project {
		t.Fatalf("graph ownership: %#v", graph.Project)
	}
	for _, intrinsic := range []any{page.Items[0], snapshot.Project, graph.Project} {
		data, err := json.Marshal(intrinsic)
		if err != nil || strings.Contains(string(data), `"access"`) || strings.Contains(string(data), `"effectiveRole"`) || strings.Contains(string(data), `"ownerTeam"`) {
			t.Fatalf("actor facts entered intrinsic Project: %s %v", data, err)
		}
	}
	accessHTTPUser(t, tx, actor, project, store.PersonalTeamFacts{})
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me", ""), 500, "internal_error")
}

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

func TestProjectSettingsProjectionAcrossRootRoutes(t *testing.T) {
	transactions := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, transactions, &logs)
	minimum := projectHTTPRecord("a0000000-0000-4000-8000-000000000001", "Settings", "https://example.com/settings.git", "00000000-0000-4000-8000-000000000101")
	minimum.Settings = model.ProjectSettings{Version: 9007199254740995, ExecutionWarningMinutes: 1}
	otherModel := projectHTTPRecord("a0000000-0000-4000-8000-000000000002", "Independent settings", "https://example.com/other.git", minimum.Ownership.TeamID)
	updated, other := projecthttp.ProjectResponse(minimum), projecthttp.ProjectResponse(otherModel)
	projectHTTPGet(t, transactions, handler.principal, minimum)
	read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+minimum.ID, ""), http.StatusOK)
	settingsHTTPProjectList(t, transactions, handler.principal, minimum, otherModel)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	const taskID = "00000000-0000-4000-8000-000000000201"
	settingsHTTPGraph(t, transactions, handler.principal, minimum, taskID)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(minimum.ID, taskID), ""), http.StatusOK)
	if read != updated || graph.Project != updated || len(page.Items) != 2 || page.Items[0] != updated || page.Items[1] != other {
		t.Fatalf("settings differ across project/get/list/graph resources: project %+v, page %+v, graph %+v", read, page, graph.Project)
	}
	projectHTTPGet(t, transactions, handler.principal, otherModel)
	if readOther := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+other.ID, ""), http.StatusOK); readOther != other {
		t.Fatal("independent project settings changed")
	}
}

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
	tasks    func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
}

func (d settingsHTTPGraphReader) TaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	return d.presence(ctx, projectID, taskID)
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
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	calls := make([]string, 0, 5)
	want := []string{"access", "project", "presence", "tasks", "observed"}
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
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, p, actor)
		projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeAll})
		projectHTTPCheck(t, page, store.Page{Limit: 50})
		return store.ProjectPage{Items: []model.Project{first, second}}, nil
	}})
}

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

type teamHTTPReader struct {
	store.TeamReader
	t    *testing.T
	Read func(context.Context, string, string) (model.Team, error)
	List func(context.Context, string, store.Page) (store.TeamPage, error)
}

func (d teamHTTPReader) Team(ctx context.Context, user, id string) (model.Team, error) {
	return d.Read(ctx, user, id)
}
func (d teamHTTPReader) Teams(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
	return d.List(ctx, user, page)
}

type teamHTTPSnapshot struct {
	store.SnapshotScope
	reader store.TeamReader
}

func (s teamHTTPSnapshot) TeamDAO() store.TeamReader { return s.reader }

type teamHTTPCreator struct {
	store.TeamCreationDAO
	insert func(context.Context, string, string) (model.Team, error)
}

func (d teamHTTPCreator) InsertTeam(ctx context.Context, id, name string) (model.Team, error) {
	return d.insert(ctx, id, name)
}

type teamHTTPWriter struct {
	store.TeamWriteDAO
	read         func(context.Context, string) (model.Team, error)
	rename       func(context.Context, string, string) (model.Team, error)
	occupied     func(context.Context) (bool, error)
	delete       func(context.Context) error
	member       func(context.Context, string) (model.TeamMember, error)
	removeMember func(context.Context, string) error
}

func (d teamHTTPWriter) Team(ctx context.Context, user string) (model.Team, error) {
	return d.read(ctx, user)
}
func (d teamHTTPWriter) Rename(ctx context.Context, user, name string) (model.Team, error) {
	return d.rename(ctx, user, name)
}
func (d teamHTTPWriter) HasProjects(ctx context.Context) (bool, error) { return d.occupied(ctx) }
func (d teamHTTPWriter) Delete(ctx context.Context) error              { return d.delete(ctx) }

func (d teamHTTPWriter) Member(ctx context.Context, user string) (model.TeamMember, error) {
	return d.member(ctx, user)
}
func (d teamHTTPWriter) RemoveMember(ctx context.Context, user string) error {
	return d.removeMember(ctx, user)
}

type teamHTTPWriteScope struct {
	store.TeamWriteScope
	dao         store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s teamHTTPWriteScope) TeamDAO() store.TeamWriteDAO                 { return s.dao }
func (s teamHTTPWriteScope) EligibilityDAO() store.WebhookEligibilityDAO { return s.eligibility }

type teamHTTPEligibility struct {
	store.WebhookEligibilityDAO
	lock func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
}

func (d teamHTTPEligibility) LockAffected(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return d.lock(ctx, f)
}

func teamHTTPCreate(t *testing.T, tx *httpTestStore, p model.Principal, name string) *model.Team {
	t.Helper()
	result := new(model.Team)
	writer, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.CreateTeamCall = func(ctx context.Context, owner string, op func(store.TeamCreationDAO) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, owner, p.UserID)
		err := op(teamHTTPCreator{insert: func(ctx context.Context, id, raw string) (model.Team, error) {
			insert()
			projectHTTPCheck(t, raw, name)
			parsed, err := uuid.Parse(id)
			if err != nil || parsed.Version() != 4 {
				t.Errorf("Team ID is not allocated UUIDv4: %s %v", id, err)
				panic("invalid Team ID")
			}
			at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			*result = model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
			return projectHTTPCopyTeam(*result), nil
		}})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return result
}
func teamHTTPRead(t *testing.T, tx *httpTestStore, p model.Principal, id string, result model.Team, readErr error) {
	t.Helper()
	snapshot, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, Read: func(ctx context.Context, user, gotID string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, gotID, id)
			return projectHTTPCopyTeam(result), readErr
		}}})
	}
}
func teamHTTPList(t *testing.T, tx *httpTestStore, p model.Principal, items []model.Team) {
	t.Helper()
	snapshot, list := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, List: func(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
			list()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, page, store.Page{Limit: 1})
			returned := slices.Clone(items)
			for index := range returned {
				returned[index] = projectHTTPCopyTeam(returned[index])
			}
			return store.TeamPage{Items: returned}, nil
		}}})
	}
}
func teamHTTPWrite(t *testing.T, tx *httpTestStore, p model.Principal, current model.Team, rename *model.Team, remove bool) {
	t.Helper()
	writer, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := teamHTTPWriter{read: func(ctx context.Context, user string) (model.Team, error) {
		read()
		projectHTTPCheck(t, user, p.UserID)
		return projectHTTPCopyTeam(current), nil
	}}
	if rename != nil {
		called := projectHTTPCount(t, 1)
		dao.rename = func(ctx context.Context, user, name string) (model.Team, error) {
			called()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, name, *rename.Name)
			return projectHTTPCopyTeam(*rename), nil
		}
	}
	var eligibility store.WebhookEligibilityDAO
	if remove {
		occupied, deleted, locked := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		dao.occupied = func(context.Context) (bool, error) { occupied(); return false, nil }
		dao.delete = func(context.Context) error { deleted(); return nil }
		eligibility = teamHTTPEligibility{lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
			locked()
			projectHTTPCheck(t, f, store.WebhookEligibilityFilter{TeamID: current.ID, TeamOwner: true})
			return nil, nil
		}}
	}
	tx.WriteTeamCall = func(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, id, current.ID)
		err := op(teamHTTPWriteScope{dao: dao, eligibility: eligibility})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func teamHTTPExit(t *testing.T, tx *httpTestStore, p model.Principal, current model.Team) {
	t.Helper()
	writer, read, member, removed, locked := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := teamHTTPWriter{
		read: func(ctx context.Context, user string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, p.UserID)
			return projectHTTPCopyTeam(current), nil
		},
		member: func(ctx context.Context, user string) (model.TeamMember, error) {
			member()
			projectHTTPCheck(t, user, p.UserID)
			return current.Membership, nil
		},
		removeMember: func(ctx context.Context, user string) error {
			removed()
			projectHTTPCheck(t, user, p.UserID)
			return nil
		},
	}
	eligibility := teamHTTPEligibility{lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
		locked()
		projectHTTPCheck(t, f, store.WebhookEligibilityFilter{TeamID: current.ID, UserID: p.UserID})
		return nil, nil
	}}
	tx.WriteTeamCall = func(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, id, current.ID)
		err := op(teamHTTPWriteScope{dao: dao, eligibility: eligibility})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func TestTeamSelfExitPreservesIndependentProjectAccessHTTP(t *testing.T) {
	actor := defaultHTTPPrincipal()
	tx := newHTTPTestStoreForPrincipal(t, actor)
	handler := resourceTestServerForPrincipal(t, tx, attachmentTestFiles(t), io.Discard, actor)
	project := projectHTTPRecord("caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Shared project", "https://example.test/independent-grant", "dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	teamName := "Shared team"
	team := model.Team{TeamRef: model.TeamRef{ID: project.Ownership.TeamID, Kind: "ordinary", Name: &teamName}, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt, Membership: model.TeamMember{TeamID: project.Ownership.TeamID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}}
	grant := model.ProjectGrant{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	teamRole := model.ProjectMemberRole
	beforeFacts := model.ProjectAccess{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, DirectGrant: &grant, OwnerTeam: team.TeamRef, Ownership: project.Ownership, TeamRole: &teamRole}
	base := "/api/v1/projects/" + project.ID
	accessHTTPProject(t, tx, actor, project, beforeFacts, "access", nil, nil)
	before := decodeResponse[api.ProjectAccess](t, projectRequest(handler, http.MethodGet, base+"/access", ""), http.StatusOK)
	expectedGrant := api.ProjectGrant{ProjectID: project.ID, UserID: actor.UserID, Role: "member", Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	if before.TeamRole == nil || *before.TeamRole != "member" || before.DirectGrant == nil || !reflect.DeepEqual(*before.DirectGrant, expectedGrant) {
		t.Fatalf("initial access does not have both sources: %+v", before)
	}
	teamHTTPExit(t, tx, actor, team)
	leave := api.RemoveTeamMemberRequest{Version: team.Membership.Version, ExpectedUserID: actor.UserID}
	receipt := decodeResponse[api.RemoveTeamMemberReceipt](t, projectRequest(handler, http.MethodDelete, "/api/v1/teams/"+team.ID+"/members/"+actor.UserID, jsonBody(t, leave)), http.StatusOK)
	if !receipt.Removed || receipt.TeamID != team.ID || receipt.UserID != actor.UserID || receipt.ActorRole != nil {
		t.Fatalf("self-exit receipt: %+v", receipt)
	}
	teamHTTPRead(t, tx, actor, team.ID, model.Team{}, model.ErrNotFound)
	denial := decodeResponse[api.ErrorResponse](t, projectRequest(handler, http.MethodGet, "/api/v1/teams/"+team.ID, ""), http.StatusNotFound)
	if denial.Error.Code != "not_found" {
		t.Fatalf("Team remains visible after exit: %+v", denial)
	}
	afterFacts := model.ProjectAccess{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, DirectGrant: &grant, OwnerTeam: team.TeamRef, Ownership: project.Ownership}
	accessHTTPProject(t, tx, actor, project, afterFacts, "project", nil, nil)
	read := decodeResponse[api.ProjectDocument](t, projectRequest(handler, http.MethodGet, base, ""), http.StatusOK)
	accessHTTPProject(t, tx, actor, project, afterFacts, "access", nil, nil)
	after := decodeResponse[api.ProjectAccess](t, projectRequest(handler, http.MethodGet, base+"/access", ""), http.StatusOK)
	if read.ID != project.ID || after.TeamRole != nil || after.EffectiveRole != "member" || !reflect.DeepEqual(after.DirectGrant, before.DirectGrant) {
		t.Fatalf("self-exit lost or changed independent Project access: %+v", after)
	}
}

type mcpBotExpectedCall struct {
	name   string
	args   []any
	result []any
	check  func([]any)
}
type mcpBotCallScript struct {
	t     *testing.T
	calls []mcpBotExpectedCall
	next  int
}

func mcpBotScript(t *testing.T, calls ...mcpBotExpectedCall) *mcpBotCallScript {
	s := &mcpBotCallScript{t: t, calls: calls}
	t.Cleanup(s.verify)
	return s
}
func (s *mcpBotCallScript) call(name string, args ...any) []any {
	if s.next >= len(s.calls) {
		unexpectedHTTPCall(s.t, "MCP Bot "+name)
	}
	c := s.calls[s.next]
	s.next++
	if name != c.name || c.check == nil && !reflect.DeepEqual(args, c.args) {
		s.t.Errorf("MCP Bot call %d got %s %#v, want %s %#v", s.next, name, args, c.name, c.args)
		panic("MCP Bot DAO call mismatch")
	}
	if c.check != nil {
		c.check(args)
	}
	return mcpCloneFixture(c.result)
}
func (s *mcpBotCallScript) verify() {
	if s.next != len(s.calls) {
		s.t.Errorf("MCP Bot calls=%d, want %d", s.next, len(s.calls))
	}
}
func mcpBotCall(name string, args []any, result ...any) mcpBotExpectedCall {
	return mcpBotExpectedCall{name: name, args: mcpCloneFixture(args), result: result}
}
func mcpBotErr(value any) error {
	if value == nil {
		return nil
	}
	return value.(error)
}
func mcpCloneFixture[T any](value T) T {
	if any(value) == nil {
		return value
	}
	errorType := reflect.TypeFor[error]()
	var clone func(reflect.Value) reflect.Value
	clone = func(in reflect.Value) reflect.Value {
		if !in.IsValid() {
			return in
		}
		if in.Type().Implements(errorType) || in.Type() == reflect.TypeFor[time.Time]() {
			return in
		}
		switch in.Kind() {
		case reflect.Interface:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.New(in.Type()).Elem()
			out.Set(clone(in.Elem()))
			return out
		case reflect.Pointer:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.New(in.Type().Elem())
			out.Elem().Set(clone(in.Elem()))
			return out
		case reflect.Slice:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.MakeSlice(in.Type(), in.Len(), in.Len())
			for i := 0; i < in.Len(); i++ {
				out.Index(i).Set(clone(in.Index(i)))
			}
			return out
		case reflect.Map:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.MakeMapWithSize(in.Type(), in.Len())
			iter := in.MapRange()
			for iter.Next() {
				out.SetMapIndex(iter.Key(), clone(iter.Value()))
			}
			return out
		case reflect.Struct:
			out := reflect.New(in.Type()).Elem()
			out.Set(in)
			for i := 0; i < in.NumField(); i++ {
				if out.Field(i).CanSet() && in.Field(i).CanInterface() {
					out.Field(i).Set(clone(in.Field(i)))
				}
			}
			return out
		default:
			return in
		}
	}
	return clone(reflect.ValueOf(value)).Interface().(T)
}

func mcpBotCredentialCall(p model.Principal) mcpBotExpectedCall {
	return mcpBotCall("Credential", []any{p}, nil)
}
func mcpBotLockCredentialCall(t *testing.T, p model.Principal) mcpBotExpectedCall {
	earliest := time.Now()
	return mcpBotExpectedCall{name: "LockCredential", result: []any{nil}, check: func(args []any) {
		observed := time.Now()
		if len(args) != 2 {
			t.Errorf("MCP Bot credential arguments = %#v, want principal and query time", args)
			panic("MCP Bot credential argument count")
		}
		now, ok := args[1].(time.Time)
		if args[0] != p || !ok || now.IsZero() || now.Before(earliest) || now.After(observed) {
			t.Errorf("MCP Bot credential actor=%#v want=%#v queryTime=%v (%T), allowed=[%v,%v]", args[0], p, args[1], args[1], earliest, observed)
			panic("MCP Bot credential actor or query time mismatch")
		}
	}}
}

type mcpBotReader struct {
	s *mcpBotCallScript
}

func (d *mcpBotReader) Bot(ctx context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotReader) Bots(ctx context.Context, owner string, worker *string, page store.Page) (store.BotPage, error) {
	r := d.s.call("Bots", owner, worker, page)
	return r[0].(store.BotPage), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	r := d.s.call("BotPreferredWorker", owner)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidate", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidates", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationWorker", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotWorker(ctx context.Context, owner, id string) error {
	return mcpBotErr(d.s.call("BotWorker", owner, id)[0])
}
func (d *mcpBotReader) BotDefaults(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotDefaults", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}

type mcpBotWriteDAO struct {
	s *mcpBotCallScript
}

func (d *mcpBotWriteDAO) Credential(ctx context.Context, p model.Principal) error {
	return mcpBotErr(d.s.call("Credential", p)[0])
}
func (d *mcpBotWriteDAO) Worker(ctx context.Context, owner, id string) error {
	return mcpBotErr(d.s.call("Worker", owner, id)[0])
}
func (d *mcpBotWriteDAO) LockCreation(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("LockCreation", id)[0])
}
func (d *mcpBotWriteDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	r := d.s.call("BotPreferredWorker", owner)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidate", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidates", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationWorker", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotDefaults(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotDefaults", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) InsertBot(ctx context.Context, b model.Bot) error {
	return mcpBotErr(d.s.call("InsertBot", b)[0])
}
func (d *mcpBotWriteDAO) SaveBotDeletion(ctx context.Context, id string, v *model.BotDeletion) (model.Bot, error) {
	r := d.s.call("SaveBotDeletion", id, v)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BindBotSession(ctx context.Context, id string, version int64, session string, role model.BotRoleConfiguration) (model.Bot, error) {
	r := d.s.call("BindBotSession", id, version, session, role)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	r := d.s.call("SetBotStartup", id, version, result)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) CommitBotPreferences(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("CommitBotPreferences", id)[0])
}

type mcpBotCredentialReader struct{ s *mcpBotCallScript }

func (d mcpBotCredentialReader) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.s.call("Credential", p)
	return store.ThreadCredential{}, nil
}

type mcpBotScope struct{ dao store.BotWriteDAO }

func (s mcpBotScope) BotDAO() store.BotWriteDAO { return s.dao }

type mcpBotSessionScope struct {
	session store.SessionDAO
	bot     store.BotWriteDAO
}

func (s mcpBotSessionScope) SessionDAO() store.SessionDAO { return s.session }
func (s mcpBotSessionScope) BotDAO() store.BotWriteDAO    { return s.bot }

type mcpBotSessionDAO struct {
	sessionHTTPRejectedDAO
	s *mcpBotCallScript
}

func (d *mcpBotSessionDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	return mcpBotErr(d.s.call("LockCredential", p, now)[0])
}
func (d *mcpBotSessionDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	r := d.s.call("SessionLocation", id)
	return r[0].(store.SessionLocation), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	r := d.s.call("SessionBotID", id)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	r := d.s.call("LockSession", id)
	return r[0].(store.SessionRecord), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) InsertBotSession(ctx context.Context, v store.SessionRegistration) (bool, error) {
	r := d.s.call("InsertBotSession", v)
	return r[0].(bool), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) LockBotSessions(ctx context.Context, id string) ([]store.BotSession, error) {
	r := d.s.call("LockBotSessions", id)
	return r[0].([]store.BotSession), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) RevokeBotSessions(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("RevokeBotSessions", id)[0])
}
func (d *mcpBotSessionDAO) LockBotSessionStop(ctx context.Context, id, bot, owner string) (store.BotSessionStop, error) {
	r := d.s.call("LockBotSessionStop", id, bot, owner)
	return r[0].(store.BotSessionStop), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) DeleteBotSession(ctx context.Context, id, bot string) error {
	return mcpBotErr(d.s.call("DeleteBotSession", id, bot)[0])
}
func (d *mcpBotSessionDAO) RedactDeletedBot(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("RedactDeletedBot", id)[0])
}
func mcpBotResult(err error) (store.Completion, error) {
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func mcpBotSnapshot(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("ReadSnapshot", nil)}, calls...)...)
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		s.call("ReadSnapshot")
		scope := newHTTPTestSnapshot(t)
		scope.Credentials = mcpBotCredentialReader{s: s}
		scope.Bots = &mcpBotReader{s: s}
		err := fn(scope)
		s.verify()
		return err
	}
}
func mcpBotWrite(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("WriteBot", nil)}, calls...)...)
	tx.WriteBotCall = func(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
		s.call("WriteBot")
		err := fn(mcpBotScope{dao: &mcpBotWriteDAO{s: s}})
		s.verify()
		return mcpBotResult(err)
	}
}
func mcpBotSession(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("WriteSession", nil)}, calls...)...)
	tx.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		s.call("WriteSession")
		err := fn(mcpBotSessionScope{session: &mcpBotSessionDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, s: s}, bot: &mcpBotWriteDAO{s: s}})
		s.verify()
		return mcpBotResult(err)
	}
}
func mcpBotDefaults(owner, worker string, now time.Time) model.BotDefaultsInput {
	modelName, reason := "gpt-5", "not_found"
	host := &model.WorkerAssistantHost{
		ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot,
		Providers: []model.WorkerAssistantProvider{
			{Provider: model.AgentCodex, Available: true, Args: []string{}},
			{Provider: model.AgentClaude, Available: false, Reason: &reason, Args: []string{}},
			{Provider: model.AgentCopilot, Available: true, Model: &modelName, Args: []string{"--effort", "high"}},
		},
	}
	return model.BotDefaultsInput{
		ObservedAt:        now,
		Workers:           []model.WorkerSnapshot{{UserID: owner, WorkerID: worker, CreatedAt: now.Add(-time.Minute), LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}}},
		WorkerPreferences: map[string]model.BotWorkerPreference{},
	}
}
func mcpBotCreation(t *testing.T, tx *httpTestStore, p model.Principal, defaults model.BotDefaultsInput, want model.Bot) {
	selection := func() []mcpBotExpectedCall {
		if want.RequestedOverrides.WorkerID != nil {
			return []mcpBotExpectedCall{mcpBotCall("BotCreationWorker", []any{p.UserID, want.WorkerID}, defaults, nil)}
		}
		return []mcpBotExpectedCall{mcpBotCall("BotPreferredWorker", []any{p.UserID}, (*string)(nil), nil), mcpBotCall("BotCreationCandidates", []any{p.UserID}, defaults, nil), mcpBotCall("BotCreationWorker", []any{p.UserID, want.WorkerID}, defaults, nil)}
	}
	reads := append([]mcpBotExpectedCall{mcpBotCredentialCall(p), mcpBotCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	mcpBotSnapshot(t, tx, reads...)
	insert := model.Bot{ID: want.ID, OwnerUserID: p.UserID, WorkerID: want.WorkerID, Name: want.Name, RequestFingerprint: want.RequestFingerprint, RequestedOverrides: want.RequestedOverrides, ResolvedConfiguration: want.ResolvedConfiguration}
	writes := append([]mcpBotExpectedCall{mcpBotCredentialCall(p), mcpBotCall("LockCreation", []any{want.ID}, nil), mcpBotCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	writes = append(writes, mcpBotCall("Worker", []any{p.UserID, want.WorkerID}, nil), mcpBotCall("InsertBot", []any{insert}, nil), mcpBotCall("Bot", []any{want.ID}, want, nil), mcpBotCredentialCall(p))
	mcpBotWrite(t, tx, writes...)
}
func mcpBotModel(owner, worker, id, name string, overrides model.BotOverrides, configuration model.BotConfiguration, now time.Time) model.Bot {
	raw, _ := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
	}{Name: name, Overrides: overrides})
	sum := sha256.Sum256(raw)
	return model.Bot{ID: id, OwnerUserID: owner, WorkerID: worker, Name: name, Version: 1, CreationOrder: 1, RequestFingerprint: hex.EncodeToString(sum[:]), RequestedOverrides: overrides, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}

var _ store.BotReader = (*mcpBotReader)(nil)
var _ store.BotWriteDAO = (*mcpBotWriteDAO)(nil)
var _ store.SessionDAO = (*mcpBotSessionDAO)(nil)

// Only the deletion-completion scope exposes the media cleanup capability.
// Calls still pass through the exact shared script and its argument checks.
type mcpBotResourceSessionDAO struct {
	*mcpBotSessionDAO
	store.SessionResourceDAO
}

func (d *mcpBotResourceSessionDAO) SessionResourceUsage(_ context.Context, id string) (store.SessionResourceUsage, error) {
	r := d.s.call("SessionResourceUsage", id)
	return r[0].(store.SessionResourceUsage), mcpBotErr(r[1])
}
func (d *mcpBotResourceSessionDAO) BeginSessionResourceDeletion(_ context.Context, id string) (int64, error) {
	r := d.s.call("BeginSessionResourceDeletion", id)
	return r[0].(int64), mcpBotErr(r[1])
}
func (d *mcpBotResourceSessionDAO) ListSessionResourceLeases(_ context.Context, id string) ([]store.SessionResourceLease, error) {
	r := d.s.call("ListSessionResourceLeases", id)
	return r[0].([]store.SessionResourceLease), mcpBotErr(r[1])
}

func TestMCPBotProductionLifecycle(t *testing.T) {
	tx := newHTTPTestStore(t)
	principal := defaultHTTPPrincipal()
	worker := uuid.NewString()
	now := time.Now().UTC()
	defaults := mcpBotDefaults(principal.UserID, worker, now)
	modelName := "gpt-5"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: &modelName, Args: []string{"--effort", "high"}}
	server, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
	h := &resourceTestHandler{Handler: server.Config.Handler, token: defaultHTTPToken(), principal: principal}
	client := mcpPATClient(t, server.URL, h.token)
	call := func(name string, args map[string]any) (map[string]any, bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err = json.Unmarshal(b, &doc); err != nil {
			t.Fatal(err)
		}
		return doc, result.IsError
	}
	obj := func(v any) map[string]any {
		t.Helper()
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("expected object: %#v", v)
		}
		return m
	}
	id := uuid.NewString()
	expected := mcpBotModel(principal.UserID, worker, id, "Assistant", model.BotOverrides{}, configuration, now)
	mcpBotCreation(t, tx, principal, defaults, expected)
	created, failed := call("bot_create", map[string]any{"name": "Assistant", "requestId": id})
	if failed {
		t.Fatalf("create: %+v", created)
	}
	data := obj(created["data"])
	config := obj(data["resolvedConfiguration"])
	if data["id"] != id || data["version"] != "1" || data["workerId"] != worker || config["cwd"] != "/workspace" || config["provider"] != "copilot" || obj(data["startupResult"])["state"] != "pending" || len(obj(data["requestedOverrides"])) != 0 {
		t.Fatalf("default create: %+v", data)
	}
	secondID := uuid.NewString()
	chosen, provider := "/chosen", "codex"
	second := mcpBotModel(principal.UserID, worker, secondID, "Second", model.BotOverrides{WorkerID: &worker, Cwd: &chosen, Provider: &provider}, model.BotConfiguration{WorkerID: worker, Cwd: chosen, Provider: provider, Args: []string{}}, now.Add(time.Second))
	mcpBotCreation(t, tx, principal, defaults, second)
	override, failed := call("bot_create", map[string]any{"name": "Second", "workerId": worker, "cwd": "/chosen", "agent": "codex", "requestId": secondID})
	if failed || obj(obj(override["data"])["resolvedConfiguration"])["cwd"] != "/chosen" || obj(obj(override["data"])["resolvedConfiguration"])["provider"] != "codex" {
		t.Fatalf("overrides: %+v", override)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bots", []any{principal.UserID, (*string)(nil), store.Page{Limit: 1}}, store.BotPage{Items: []model.Bot{expected}, HasMore: true}, nil))
	page, failed := call("bot_list", map[string]any{"limit": 1})
	if failed {
		t.Fatalf("list: %+v", page)
	}
	first := obj(page["data"])
	items := first["items"].([]any)
	cursor, ok := first["nextCursor"].(string)
	if len(items) != 1 || !ok {
		t.Fatalf("first page: %+v", first)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bots", []any{principal.UserID, (*string)(nil), store.Page{Limit: 1, After: &store.Position{CreatedAt: expected.CreatedAt, ID: expected.ID}}}, store.BotPage{Items: []model.Bot{second}}, nil))
	next, failed := call("bot_list", map[string]any{"limit": 1, "cursor": cursor})
	if failed || len(obj(next["data"])["items"].([]any)) != 1 || obj(obj(next["data"])["items"].([]any)[0])["id"] == obj(items[0])["id"] {
		t.Fatalf("second page: %+v", next)
	}
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, expected, nil))
	read, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(read["data"])["id"] != id {
		t.Fatalf("show: %+v", read)
	}
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	instructions := "Use Daynight CLI."
	registration := map[string]any{"botVersion": "1", "registration": reg, "configuration": config, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
	base := "/api/v1/me/workers/" + worker + "/bots/" + id
	var inserted store.SessionRegistration
	bindingResult := []any{model.Bot{}, nil}
	bindCall := mcpBotExpectedCall{name: "BindBotSession", result: bindingResult, check: func(args []any) {
		if len(args) != 4 || args[0] != id || args[1] != int64(1) || args[2] != inserted.Location.SessionID || args[3] != (model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}) {
			unexpectedHTTPCall(t, "Bot binding fields")
		}
		value := expected
		value.Version = 2
		value.SessionID = &inserted.Location.SessionID
		value.TestExecutionID = &reg.TestExecutionID
		value.RoleConfiguration = &model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
		value.UpdatedAt = now.Add(time.Second)
		bindingResult[0] = value
	}}
	insertCall := mcpBotExpectedCall{name: "InsertBotSession", result: []any{true, nil}, check: func(args []any) {
		value := args[0].(store.SessionRegistration)
		if value.OwnerID != principal.UserID || value.ParentCredentialID != principal.CredentialID || value.BotID == nil || *value.BotID != id || value.RegistrationID != reg.RegistrationID || value.TestExecutionID != reg.TestExecutionID || value.Location.SessionID == "" || value.Snapshot.TestExecutionID != reg.TestExecutionID || value.Snapshot.Identity.OwnerUserID != principal.UserID || value.Snapshot.Identity.Provider != "copilot" || value.Snapshot.ConnectionEpoch != "0" || value.Snapshot.ExecutionGeneration != "1" || value.Snapshot.InitialInputState != "not_required" {
			unexpectedHTTPCall(t, "Bot Session registration fields")
		}
		var input map[string]any
		if err := json.Unmarshal(value.Registration, &input); err != nil || input["botVersion"] != "1" {
			unexpectedHTTPCall(t, "Bot Session frozen registration")
		}
		inserted = value
	}}
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, expected, nil), insertCall, bindCall, mcpBotLockCredentialCall(t, principal))
	bound := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(h, "POST", base+"/register", jsonBody(t, registration)), 200)
	boundModel := expected
	boundModel.Version = 2
	boundModel.SessionID = &bound.Session.SessionID
	boundModel.TestExecutionID = &reg.TestExecutionID
	boundModel.RoleConfiguration = &model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
	boundModel.UpdatedAt = now.Add(time.Second)
	record := store.SessionRecord{BotID: &id, Snapshot: bound.Session, Owner: principal.UserID, Parent: principal.CredentialID, Registration: inserted.Registration}
	mcpBotSession(t, tx, mcpBotCall("SessionBotID", []any{bound.Session.SessionID}, &id, nil), mcpBotCall("Bot", []any{id}, boundModel, nil), mcpBotCall("LockSession", []any{bound.Session.SessionID}, record, nil), mcpBotLockCredentialCall(t, principal), mcpBotLockCredentialCall(t, principal))
	decodeResponse[sp.Snapshot](t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 200)
	deletionID := uuid.NewString()
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, boundModel, nil))
	stale, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	if !failed || obj(stale["error"])["code"] != "version_conflict" {
		t.Fatalf("stale delete: %+v", stale)
	}
	deletionModel := boundModel
	deletionModel.Version = 3
	deletionModel.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deletionModel.UpdatedAt = now.Add(2 * time.Second)
	botSessions := []store.BotSession{{ID: bound.Session.SessionID, Owner: principal.UserID, Scope: "test", Backend: "web"}}
	mcpBotSession(t, tx, mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, boundModel, nil), mcpBotCall("LockBotSessions", []any{id}, botSessions, nil), mcpBotCall("RevokeBotSessions", []any{id}, nil), mcpBotCall("SaveBotDeletion", []any{id, deletionModel.Deletion}, deletionModel, nil), mcpBotLockCredentialCall(t, principal))
	deleted, failed := call("bot_delete", map[string]any{"botId": id, "ifVersion": "2", "requestId": deletionID})
	if failed {
		t.Fatalf("delete: %+v", deleted)
	}
	data = obj(deleted["data"])
	deletion := obj(data["deletion"])
	if _, exists := data["name"]; exists || deletion["deletionId"] != deletionID || obj(deletion["workerCleanup"])["state"] != "pending" || obj(deletion["serverCleanup"])["state"] != "pending" {
		t.Fatalf("deletion responsibility: %+v", data)
	}
	mcpBotSession(t, tx, mcpBotCall("SessionBotID", []any{bound.Session.SessionID}, &id, nil), mcpBotCall("Bot", []any{id}, deletionModel, nil))
	assertProjectError(t, projectRequest(h, "GET", "/api/v1/test-sessions/"+bound.Session.SessionID, ""), 409, "resource_conflict")
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, deletionModel, nil))
	shown, failed := call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(shown["data"])["deletion"])["deletionId"] != deletionID {
		t.Fatalf("show deletion: %+v", shown)
	}
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: bound.Session.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	receipt := map[string]any{"deletionId": deletionID, "stop": stop, "result": map[string]any{"state": "completed", "code": nil}}
	workerComplete := deletionModel
	workerComplete.Version = 4
	workerComplete.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	rawReceipt, _ := json.Marshal(struct {
		DeletionID string                 `json:"deletionId"`
		Stop       *sp.TestStop           `json:"stop"`
		Result     model.BotCleanupResult `json:"result"`
	}{DeletionID: deletionID, Stop: &stop, Result: model.BotCleanupResult{State: "completed"}})
	receiptHash := sha256.Sum256(rawReceipt)
	workerComplete.Deletion.ReceiptDigest = fmt.Sprintf("%x", receiptHash)
	final := workerComplete
	final.Version = 5
	final.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "completed"}, ReceiptDigest: workerComplete.Deletion.ReceiptDigest}
	receiptScript := mcpBotScript(t,
		mcpBotCall("WriteSession", nil), mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, deletionModel, nil),
		mcpBotCall("LockBotSessionStop", []any{bound.Session.SessionID, id, principal.UserID}, store.BotSessionStop{Snapshot: bound.Session}, nil),
		mcpBotCall("SaveBotDeletion", []any{id, workerComplete.Deletion}, workerComplete, nil),
		mcpBotCall("WriteSession", nil), mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, workerComplete, nil),
		mcpBotCall("LockBotSessions", []any{id}, botSessions, nil),
		mcpBotCall("SessionResourceUsage", []any{bound.Session.SessionID}, store.SessionResourceUsage{}, nil),
		mcpBotCall("BeginSessionResourceDeletion", []any{bound.Session.SessionID}, int64(1), nil),
		mcpBotCall("WriteSession", nil), mcpBotCall("ListSessionResourceLeases", []any{bound.Session.SessionID}, []store.SessionResourceLease{}, nil),
		mcpBotCall("WriteSession", nil), mcpBotLockCredentialCall(t, principal), mcpBotCall("Bot", []any{id}, workerComplete, nil),
		mcpBotCall("LockBotSessions", []any{id}, botSessions, nil), mcpBotCall("DeleteBotSession", []any{bound.Session.SessionID, id}, nil),
		mcpBotCall("RedactDeletedBot", []any{id}, nil), mcpBotCall("SaveBotDeletion", []any{id, final.Deletion}, final, nil))
	tx.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		receiptScript.call("WriteSession")
		err := fn(mcpBotSessionScope{session: &mcpBotResourceSessionDAO{mcpBotSessionDAO: &mcpBotSessionDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, s: receiptScript}}, bot: &mcpBotWriteDAO{s: receiptScript}})
		return mcpBotResult(err)
	}
	completed := decodeResponse[api.Bot](t, projectRequest(h, "POST", base+"/deletion-complete", jsonBody(t, receipt)), 200)
	if completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup: %+v", completed)
	}
	receiptScript.verify()
	mcpBotSnapshot(t, tx, mcpBotCredentialCall(principal), mcpBotCall("Bot", []any{id}, final, nil))
	shown, failed = call("bot_show", map[string]any{"botId": id})
	if failed || obj(obj(obj(shown["data"])["deletion"])["serverCleanup"])["state"] != "completed" {
		t.Fatalf("completed show: %+v", shown)
	}
}

func newMCPHTTPServer(t *testing.T, tx store.Transactions, files filestorage.Storage, outputs ...io.Writer) (*httptest.Server, *sessionApplication) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	config := configuredTestConfig()
	config.Server.PublicOrigin = origin
	config.UniAuth.CallbackURL = origin + "/api/v1/auth/callback"
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	output := io.Discard
	if len(outputs) > 1 {
		t.Fatal("MCP fixture accepts at most one log writer")
	}
	if len(outputs) == 1 {
		output = outputs[0]
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: tx, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	app := handler.(*sessionApplication)
	server.Config.Handler = httpx.RequestLogging(logger, app)
	server.Start()
	t.Cleanup(func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("MCP application shutdown: %v", err)
		}
	})
	return server, app
}

type mcpPATTransport struct{ token string }

func (t mcpPATTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}

func mcpPATClient(t *testing.T, address, token string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "mcp-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: address + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatalf("connect MCP: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func assertMCPProductionTools(t *testing.T, tools []*sdk.Tool) {
	t.Helper()
	want := map[string]bool{
		"project_create": true, "project_transfer": true, "project_list": true, "project_resolve": true, "project_show": true,
		"team_create": true, "team_rename": true, "team_delete": true, "team_leave": true,
		"team_list": true, "team_show": true, "team_projects": true, "team_member_list": true,
		"team_member_set_role": true, "team_member_remove": true,
		"team_invitation_create": true, "team_invitation_list": true, "team_invitation_revoke": true,
		"invitation_inspect": true, "invitation_accept": true,
		"bot_list": true, "bot_show": true, "bot_create": true, "bot_delete": true,
		"tag_list": true, "tag_show": true, "tag_create": true, "tag_rename": true, "tag_delete": true,
		"task_session_send": true, "task_session_operation": true,
		"task_thread_read": true, "task_thread_post": true,
		"task_step_list": true, "task_step_show": true, "task_step_add": true, "task_step_update": true,
		"task_step_set_status": true, "task_step_move": true, "task_step_delete": true,
		"task_create": true, "task_show": true, "task_update": true, "task_set_status": true,
		"task_delete": true, "task_properties": true, "task_set_property": true, "task_remove_property": true,
		"task_attachment_list": true, "task_attachment_read": true, "task_attachment_remove": true, "task_attachment_put": true,
		"task_list": true, "task_ready": true, "task_search": true, "task_graph": true, "task_work_list": true,
		"task_session_current": true, "task_session_list": true, "task_session_show": true,
		"task_session_read": true, "task_session_entry": true,
	}
	for _, tool := range tools {
		if !want[tool.Name] {
			t.Errorf("unexpected or duplicate production tool %s", tool.Name)
			continue
		}
		delete(want, tool.Name)
	}
	for name := range want {
		t.Errorf("missing production tool %s", name)
	}
}

func configureMCPPrincipals(t *testing.T, tx *httpTestStore, supplied map[string]model.Principal) {
	t.Helper()
	type credential struct {
		principal model.Principal
		hash      []byte
	}
	credentials := make([]credential, 0, len(supplied))
	for token, principal := range supplied {
		if token == "" || principal.UserID == "" || principal.CredentialID == "" || (principal.Kind != model.PATCredential && principal.Kind != model.SessionCredential) {
			t.Fatalf("invalid declared MCP authentication fixture: %+v", principal)
		}
		prefix := "dnpat_"
		if principal.Kind == model.SessionCredential {
			prefix = "dnst_"
		}
		if !secret.Valid(token, prefix) {
			t.Fatalf("declared MCP authentication credential is not canonical: %s", principal.Kind)
		}
		credentials = append(credentials, credential{principal: principal, hash: secret.Hash(token)})
	}
	tx.WriteIdentityCall = func(ctx context.Context, callback func(store.IdentityScope) error) (store.Completion, error) {
		dao := &mcpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		dao.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
			dao.calls++
			if dao.calls != 1 || now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "MCP authentication arguments/count")
			}
			for _, fixture := range credentials {
				if kind == fixture.principal.Kind && bytes.Equal(hash, fixture.hash) {
					return fixture.principal, nil
				}
			}
			unexpectedHTTPCall(t, "MCP authentication undeclared credential")
			panic("unreachable")
		}
		err := callback(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			t.Errorf("MCP authentication calls = %d, want 1", dao.calls)
		}
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

type mcpAuthenticationDAO struct {
	httpRejectedIdentityDAO
	authenticate func(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
	calls        int
}

func (d *mcpAuthenticationDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	return d.authenticate(ctx, kind, hash, now)
}

func TestMCPProductionPATIsolationAndRevocation(t *testing.T) {
	database := newHTTPTestStore(t)
	files := attachmentTestFiles(t)
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	principals := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	browserPrincipal := principals[0]
	browserPrincipal.Kind = model.SessionCredential
	browserPrincipal.CredentialID = "e5555555-5555-4555-8555-555555555555"
	browserToken := httpTestToken(model.SessionCredential)
	configureMCPPrincipals(t, database, map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1], browserToken: browserPrincipal})
	production, _ := newMCPHTTPServer(t, database, files)
	origin := production.URL
	config := configuredTestConfig()
	config.Server.PublicOrigin = origin
	config.UniAuth.CallbackURL = origin + "/api/v1/auth/callback"
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	newApp := func() *sessionApplication {
		handler, err := newTestHandler(Dependencies{Store: database, Files: files}, config, logger)
		if err != nil {
			t.Fatal(err)
		}
		app := handler.(*sessionApplication)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := app.Shutdown(ctx); err != nil {
				t.Errorf("shutdown: %v", err)
			}
		})
		return app
	}
	if principals[0].UserID == principals[1].UserID || principals[0].CredentialID == principals[1].CredentialID {
		t.Fatal("fixture PATs do not identify distinct accounts and credentials")
	}
	productionClient := mcpPATClient(t, production.URL, tokens[0])
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	list, err := productionClient.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("production tools: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
	project := projectHTTPRecord("f6666666-6666-4666-8666-666666666666", "MCP queries", "host:mcp-queries", "a7777777-7777-4777-8777-777777777777")
	created := model.Task{ID: "b8888888-8888-4888-8888-888888888888", ProjectID: project.ID, Title: "Ready task", Description: "Complete description", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, Ready: true, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}}
	call := func(session *sdk.ClientSession, name string, args map[string]any, wantError bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError != wantError {
			t.Fatalf("%s: %#v, %v", name, result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, name := range []string{"task_list", "task_ready"} {
		for _, view := range []string{"summary", "full"} {
			mcpIsolationTaskRead(t, database, principals[0], project, created, name, view)
			value := call(productionClient, name, map[string]any{"projectId": project.ID, "view": view}, false)
			data := value["data"].(map[string]any)
			items := data["items"].([]any)
			if data["projection"] != view || len(items) != 1 || items[0].(map[string]any)["id"] != created.ID || items[0].(map[string]any)["version"] != "1" {
				t.Fatalf("%s %s: %#v", name, view, value)
			}
			if name == "task_ready" && view == "full" && items[0].(map[string]any)["description"] != "Complete description" {
				t.Fatalf("ready full: %#v", value)
			}
			if name == "task_list" {
				assertMCPUnstartedObservation(t, items[0].(map[string]any))
			}
		}
	}
	for _, view := range []string{"summary", "full"} {
		mcpIsolationTaskRead(t, database, principals[0], project, created, "task_graph", view)
		value := call(productionClient, "task_graph", map[string]any{"projectId": project.ID, "taskId": created.ID, "view": view}, false)
		data := value["data"].(map[string]any)
		if data["projection"] != view || len(data["tasks"].([]any)) != 1 {
			t.Fatalf("graph %s: %#v", view, value)
		}
		assertMCPUnstartedObservation(t, data["tasks"].([]any)[0].(map[string]any))
	}
	bobQueries := mcpPATClient(t, production.URL, tokens[1])
	denyCounts := newHTTPCallPlan(t, map[string]int{"denied snapshot": 1, "denied credential": 1, "denied access": 1})
	deniedSnapshot := newHTTPTestSnapshot(t)
	deniedSnapshot.Credentials = &taskHTTPCredentialReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP denied observation credential"), CredentialFn: func(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
		denyCounts.Called("denied credential")
		mcpAttachmentCheck(t, p, principals[1])
		return store.ThreadCredential{}, nil
	}}
	deniedSnapshot.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		denyCounts.Called("denied access")
		mcpAttachmentCheck(t, p, principals[1])
		mcpAttachmentCheck(t, id, project.ID)
		return model.ProjectAccess{}, model.ErrNotFound
	}}
	database.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		denyCounts.Called("denied snapshot")
		return fn(deniedSnapshot)
	}
	if value := call(bobQueries, "task_list", map[string]any{"projectId": project.ID}, true); value["error"] == nil {
		t.Fatalf("unauthorized project: %#v", value)
	}

	// A separate production router with an explicitly test-only tool exposes the
	// authenticated request actor without adding a discoverable production tool.
	instrumented := newApp()
	entry := instrumented.mcp
	input := map[string]any{"type": "object"}
	output := map[string]any{"type": "object"}
	err = entry.RegisterTool(&sdk.Tool{Name: "test_actor", InputSchema: input, OutputSchema: output}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "credential": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, instrumented))
	t.Cleanup(server.Close)
	sessions := []*sdk.ClientSession{mcpPATClient(t, server.URL, tokens[0]), mcpPATClient(t, server.URL, tokens[1])}
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for i := range sessions {
		wg.Go(func() {
			for range 12 {
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				result, err := sessions[i].CallTool(ctx, &sdk.CallToolParams{Name: "test_actor", Arguments: map[string]any{}})
				cancel()
				if err != nil || result.IsError {
					failures <- fmt.Errorf("tool call %d: %v", i, err)
					return
				}
				encoded, err := json.Marshal(result.StructuredContent)
				if err != nil {
					failures <- err
					return
				}
				var envelope struct {
					Data struct{ User, Credential, Kind string }
				}
				if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Data.User != principals[i].UserID || envelope.Data.Credential != principals[i].CredentialID || envelope.Data.Kind != "pat" {
					failures <- fmt.Errorf("unexpected actor for client %d: %s (%v)", i, encoded, err)
					return
				}
			}
		})
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}

	assertStatus := func(token string, expected int) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, production.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2026-07-28")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != expected {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			t.Errorf("MCP status: got %d, want %d: %s", resp.StatusCode, expected, body)
		}
	}
	assertStatus("invalid", http.StatusUnauthorized)
	configureMCPPrincipals(t, database, map[string]model.Principal{tokens[0]: principals[0], tokens[1]: principals[1], browserToken: browserPrincipal})
	mcpIsolationRevocation(t, database, browserPrincipal, principals[0].CredentialID)
	revoke, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, origin+"/api/v1/me/tokens/"+principals[0].CredentialID, nil)
	if err != nil {
		t.Fatal(err)
	}
	revoke.Header.Set("Origin", origin)
	revoke.AddCookie(&http.Cookie{Name: "daynight_session", Value: browserToken})
	resp, err := http.DefaultClient.Do(revoke)
	if err != nil {
		t.Fatal(err)
	}
	if err = resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: HTTP %d", resp.StatusCode)
	}
	mcpIsolationRevokedAuthentication(t, database, tokens[0], tokens[1], principals[1])
	assertStatus(tokens[0], http.StatusUnauthorized)
	bobProduction := mcpPATClient(t, production.URL, tokens[1])
	ctx, cancel = context.WithTimeout(t.Context(), 5*time.Second)
	list, err = bobProduction.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("remaining PAT discovery: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
}

func mcpAttachmentCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MCP attachment DAO arguments: got %#v, want %#v", got, want)
		panic("MCP attachment DAO contract violated")
	}
}

func assertMCPUnstartedObservation(t *testing.T, item map[string]any) {
	t.Helper()
	observation, ok := item["session"].(map[string]any)
	if !ok || observation["observation"] != "observed" || observation["registration"] != "not_applicable" || observation["reason"] != "not_started" {
		t.Fatalf("unstarted Task observation: %#v", item)
	}
	send, ok := observation["send"].(map[string]any)
	if !ok || send["allowed"] != false || send["reason"] != "not_started" {
		t.Fatalf("unstarted Task send eligibility: %#v", observation)
	}
}

func mcpIsolationTaskRead(t *testing.T, tx *httpTestStore, p model.Principal, project model.Project, target model.Task, name, view string) {
	want := map[string]int{"snapshot": 1, "access": 1, "priority": 1}
	if name == "task_list" {
		want["fence"] = 1
	}
	if view == "full" {
		want["task"] = 1
	}
	if name == "task_graph" {
		delete(want, "priority")
		delete(want, "fence")
		delete(want, "task")
		want["project"] = 1
		want["presence"] = 1
		want["nodes"] = 1
		want["clock"] = 1
	}
	if name != "task_ready" {
		want["snapshot"] = 2
		want["access"] = 2
		want["credential"] = 2
		want["sources"] = 2
		want["clock"]++
	}
	counts := newHTTPCallPlan(t, want)
	scope := newHTTPTestSnapshot(t)
	if name != "task_ready" {
		scope.Credentials = &taskHTTPCredentialReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation credential"), CredentialFn: func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
			counts.Called("credential")
			mcpAttachmentCheck(t, actor, p)
			return store.ThreadCredential{}, nil
		}}
		scope.Sessions = &taskHTTPSessionReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation sources"), TaskSessionSourcesFn: func(ctx context.Context, pid string, ids []string) ([]store.TaskSessionSource, error) {
			counts.Called("sources")
			mcpAttachmentCheck(t, pid, project.ID)
			mcpAttachmentCheck(t, ids, []string{target.ID})
			return []store.TaskSessionSource{{ProjectID: project.ID, TaskID: target.ID, TaskVersion: target.Version, TaskStatus: target.Status}}, nil
		}}
	}
	scope.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project.ID)
		return projectHTTPAccess(p, project), nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		counts.Called("project")
		mcpAttachmentCheck(t, id, project.ID)
		return project, nil
	}}
	reader := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP isolation Task")}
	reader.TaskListFenceFn = func(ctx context.Context, id string) (store.TaskListFence, error) {
		counts.Called("fence")
		mcpAttachmentCheck(t, id, project.ID)
		return store.TaskListFence{Count: "1", VersionSum: "1"}, nil
	}
	reader.TaskPriorityListFn = func(ctx context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		counts.Called("priority")
		mcpAttachmentCheck(t, id, project.ID)
		expected := store.TaskPriorityQuery{TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}, Type: model.TaskTypeTask, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Limit: 50, ExcludeTerminal: true}
		if name == "task_ready" {
			status, ready := model.TaskTodo, true
			expected = store.TaskPriorityQuery{TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}, Type: model.TaskTypeTask, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Status: &status, Ready: &ready, Limit: 5}
		}
		mcpAttachmentCheck(t, q, expected)
		summary := mcpCloneFixture(target)
		summary.Description = ""
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: summary}}}, nil
	}
	reader.TaskBodiesFn = func(ctx context.Context, pid string, ids []string) ([]model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, pid, project.ID)
		mcpAttachmentCheck(t, ids, []string{target.ID})
		return []model.Task{mcpCloneFixture(target)}, nil
	}
	reader.TaskFn = func(ctx context.Context, pid, id string) (model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return mcpCloneFixture(target), nil
	}
	reader.TaskPresenceFn = func(ctx context.Context, pid, id string) (store.TaskPresence, error) {
		counts.Called("presence")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return store.TaskPresence{Found: true}, nil
	}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	reader.TaskGraphTasksFn = func(ctx context.Context, pid, id string, q store.TaskGraphSelection, n int) ([]model.GraphTask, error) {
		counts.Called("nodes")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		mcpAttachmentCheck(t, q, selection)
		mcpAttachmentCheck(t, n, 160)
		return []model.GraphTask{{ID: target.ID, Version: target.Version, TitlePreview: target.Title, Status: target.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: target.CreatedAt, UpdatedAt: target.UpdatedAt}}, nil
	}
	scope.Tasks = reader
	scope.ObservedAtCall = func(context.Context) (time.Time, error) { counts.Called("clock"); return target.UpdatedAt, nil }
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		counts.Called("snapshot")
		return fn(scope)
	}
}

type mcpIsolationRevocationDAO struct {
	httpRejectedIdentityDAO
	session model.Principal
	tokenID string
	calls   *httpCallPlan
}

func (d *mcpIsolationRevocationDAO) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	d.calls.Called("session lock")
	mcpAttachmentCheck(d.t, p, d.session)
	if now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "revocation time")
	}
	return nil
}
func (d *mcpIsolationRevocationDAO) DeletePAT(ctx context.Context, owner, id string) error {
	d.calls.Called("PAT delete")
	mcpAttachmentCheck(d.t, []string{owner, id}, []string{d.session.UserID, d.tokenID})
	return nil
}
func mcpIsolationRevocation(t *testing.T, tx *httpTestStore, browser model.Principal, tokenID string) {
	before := tx.WriteIdentityCall
	calls := newHTTPCallPlan(t, map[string]int{"identity callback": 2, "session lock": 1, "PAT delete": 1})
	phase := 0
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		calls.Called("identity callback")
		phase++
		if phase == 1 {
			return before(ctx, fn)
		}
		dao := &mcpIsolationRevocationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, session: browser, tokenID: tokenID, calls: calls}
		return mcpBotResult(fn(httpAuthenticationScope{t: t, dao: dao}))
	}
}
func mcpIsolationRevokedAuthentication(t *testing.T, tx *httpTestStore, revokedToken, otherToken string, other model.Principal) {
	revokedHash, otherHash := secret.Hash(revokedToken), secret.Hash(otherToken)
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		dao := &mcpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		dao.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
			dao.calls++
			if dao.calls != 1 || kind != model.PATCredential || now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "revoked MCP authentication")
			}
			if bytes.Equal(hash, revokedHash) {
				return model.Principal{}, model.ErrNotFound
			}
			if bytes.Equal(hash, otherHash) {
				return other, nil
			}
			unexpectedHTTPCall(t, "undeclared MCP credential")
			panic("unreachable")
		}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			unexpectedHTTPCall(t, "MCP authentication count")
		}
		return mcpBotResult(err)
	}
}

func TestStepsHTTPEditPreservesReferencedAttachment(t *testing.T) {
	f, handler, task := stepsHTTPFixture(t, io.Discard)
	path := taskPath(task) + "/steps"
	file := attachmentFilePath(task, "plans/evidence.bin")
	content := []byte{0, 0xff, 0x80, '\n', 'x'}
	metadata := f.referencedAttachment("plans/evidence.bin", "application/octet-stream", content)
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	at := f.observed
	original := model.TaskStep{ID: "abcdef01", Title: "Evidence", Description: "[Evidence](plans/evidence.bin)", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{}, Operation: "add", Candidate: original, Observed: at})
	added := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"version": task.Version, "id": "abcdef01", "title": "Evidence", "description": "[Evidence](plans/evidence.bin)"})), http.StatusCreated)
	if len(added.Steps) != 1 {
		t.Fatalf("initial Step: %+v", added)
	}
	header.Version = 2
	at = at.Add(time.Minute)
	candidate := original
	candidate.Title = "Updated evidence"
	candidate.Description = ""
	candidate.UpdatedAt = at
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{original}, Operation: "change", Candidate: candidate, Observed: at})
	changed := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPatch, path+"/abcdef01", jsonBody(t, map[string]any{"version": added.Version, "title": "Updated evidence", "description": ""})), http.StatusOK)
	if changed.Version != added.Version+1 || len(changed.Steps) != 1 || changed.Steps[0].ID != original.ID || changed.Steps[0].Title != "Updated evidence" || changed.Steps[0].Description != "" || changed.Steps[0].Status != original.Status || changed.Steps[0].CreatedAt != original.CreatedAt {
		t.Fatalf("edited Step: %+v", changed)
	}
	f.expectAttachmentRead(metadata)
	response := attachmentRequest(handler, http.MethodGet, file, "", nil)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), content) {
		t.Fatalf("editing changed attachment bytes: %d %x", response.Code, response.Body.Bytes())
	}
	f.expectAttachmentRead(metadata)
	page := decodeResponse[api.AttachmentPage](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/attachments", ""), http.StatusOK)
	want := api.Attachment{Path: metadata.Path, ContentType: metadata.ContentType, SizeBytes: metadata.SizeBytes, CreatedAt: metadata.CreatedAt, UpdatedAt: metadata.UpdatedAt}
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], want) {
		t.Fatalf("editing changed attachment metadata: %+v", page)
	}
}

func TestStepsHTTPRevokedMemberCannotRead(t *testing.T) {
	f, _, task := stepsHTTPFixture(t, io.Discard)
	admin := defaultHTTPPrincipal()
	admin.Kind = model.SessionCredential
	member := model.Principal{UserID: "b6666666-6666-4666-8666-666666666666", CredentialID: "c7777777-7777-4777-8777-777777777777", Kind: model.SessionCredential}
	path := taskPath(task) + "/steps"
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	at := f.observed
	step := model.TaskStep{ID: "abcdef01", Title: "Secret Step", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: []model.TaskStep{}, Operation: "add", Candidate: step, Observed: at})
	created := decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "POST", path, `{"version":1,"id":"abcdef01","title":"Secret Step"}`, configuredTestConfig().Server.PublicOrigin, 201, ""), 201)
	header.Version = 2
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsRead(header, []model.TaskStep{step})
	before := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "GET", path, "", "", 200, ""), 200)
	if !reflect.DeepEqual(before, created) {
		t.Fatal("member could not read granted Step")
	}
	for _, suffix := range []string{"", "/abcdef01"} {
		f.expectStepAccessError(false)
		f.authenticatedRequest(member, "GET", path+suffix, "", "", 404, "not_found")
	}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsRead(header, []model.TaskStep{step})
	after := decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "GET", path, "", "", 200, ""), 200)
	if !reflect.DeepEqual(after, created) {
		t.Fatal("denied member read changed owner's Steps")
	}
}

func TestTaskHTTPSoftDeletionAndGoneResources(t *testing.T) {
	var logs bytes.Buffer
	f, handler, task := stepsHTTPFixture(t, &logs)
	path := taskPath(task)
	current := f.target
	current.Title = "Private deleted body"
	deletedAt := current.UpdatedAt.Add(time.Minute)
	prepareWrite := func(success bool, readError error) {
		base := newTaskHTTPMockBase(t, "Task deletion")
		want := map[string]int{"write": 1, "access": 1, "task": 1}
		if success {
			for _, name := range []string{"dependents", "delete", "drain", "receipts", "invalidate", "capture"} {
				want[name] = 1
			}
		}
		plan := newHTTPCallPlan(t, want)
		projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
		projects.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
			plan.Called("access")
			if p != f.principal || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete actor")
			}
			return taskHTTPMockAccess(f.project, p), nil
		}
		projects.InvalidateTaskCacheFn = func(ctx context.Context) error { plan.Called("invalidate"); return ctx.Err() }
		writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			plan.Called("task")
			if id != current.ID || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete Task identity")
			}
			return copyTaskHTTPTask(current), readError
		}
		writer.DependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			plan.Called("dependents")
			if id != current.ID || ctx.Err() != nil {
				unexpectedHTTPCall(t, "dependent Task identity")
			}
			return []string{}, nil
		}
		writer.DeleteTaskFn = func(ctx context.Context, id string, remove bool) (model.TaskTombstone, error) {
			plan.Called("delete")
			if id != current.ID || remove || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete arguments")
			}
			return model.TaskTombstone{ProjectID: current.ProjectID, ID: current.ID, Version: 2, DeletedAt: deletedAt}, nil
		}
		sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, v store.TaskSessionDrain) error {
			plan.Called("drain")
			if id != current.ID || v.ActiveClaim != nil || v.SourceLifecycle != "active" || v.GraceSeconds != 60 || v.TimelineField != "lastTimelineSeq" || v.LifecycleField != "lifecycle" || !reflect.DeepEqual(v.RemoveFields, []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}) || !reflect.DeepEqual(v.SnapshotValues, map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}) {
				unexpectedHTTPCall(t, "delete Session drain")
			}
			return ctx.Err()
		}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, v store.TaskSessionReceiptTransition) error {
			plan.Called("receipts")
			if id != current.ID || v.LifecycleField != "lifecycle" || v.Lifecycle != "draining" || v.StateField != "state" || v.PreviousState != "accepted" || v.NextState != "rejected" || !reflect.DeepEqual(v.RemoveFields, []string{"error"}) {
				unexpectedHTTPCall(t, "delete receipt transition")
			}
			return ctx.Err()
		}
		capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base, FreezeAudienceFn: func(ctx context.Context, id string, types []string) ([]store.WebhookAudience, error) {
			plan.Called("capture")
			if id != current.ProjectID || !reflect.DeepEqual(types, []string{protocol.Deleted}) || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete source")
			}
			return []store.WebhookAudience{}, nil
		}}
		scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
		f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
			plan.Called("write")
			if id != current.ProjectID || run == nil {
				unexpectedHTTPCall(t, "delete Project scope")
			}
			err := run(scope)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		}
	}
	prepareWrite(false, nil)
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, `{"version":2}`), 409, "version_conflict")
	prepareWrite(true, nil)
	response := projectRequest(handler, http.MethodDelete, path, jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if response.Code != 204 || response.Body.Len() != 0 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("delete result: %d %s %v", response.Code, response.Body, response.Header())
	}
	for _, call := range []struct{ method, suffix, body string }{{http.MethodGet, "", ""}, {http.MethodDelete, "", `{"version":2}`}, {http.MethodPatch, "", `{"version":2,"title":"Changed"}`}, {http.MethodPut, "/status", `{"version":2,"status":"done"}`}, {http.MethodGet, "/attachments", ""}, {http.MethodGet, "/attachments/files/evidence.txt", ""}, {http.MethodGet, "/preview/evidence.txt", ""}} {
		if call.method == http.MethodGet {
			counts := map[string]int{"task": 1}
			if call.suffix != "" {
				counts = map[string]int{"presence": 1}
			}
			f.expectSnapshot(counts, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
				reader.TaskFn = func(ctx context.Context, project, id string) (model.Task, error) {
					f.require(ctx, project)
					plan.Called("task")
					if id != task.ID {
						unexpectedHTTPCall(t, "deleted Task read")
					}
					return model.Task{}, model.ErrTaskDeleted
				}
				reader.TaskPresenceFn = func(ctx context.Context, project, id string) (store.TaskPresence, error) {
					f.require(ctx, project)
					plan.Called("presence")
					if id != task.ID {
						unexpectedHTTPCall(t, "deleted attachment parent")
					}
					return store.TaskPresence{Found: true, DeletedAt: &deletedAt}, nil
				}
			})
		} else {
			prepareWrite(false, model.ErrTaskDeleted)
		}
		assertProjectError(t, projectRequest(handler, call.method, path+call.suffix, call.body), 410, "task_deleted")
	}
	f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: []model.Task{}}})
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(task.ProjectID), ""), 200)
	if len(page.Items) != 0 {
		t.Fatal("deleted Task is still listed")
	}
	if !strings.Contains(logs.String(), `"phase":"delete"`) || !strings.Contains(logs.String(), `"cause":"task_deleted"`) || strings.Contains(logs.String(), current.Title) {
		t.Fatalf("missing or unsafe deletion diagnostics: %s", &logs)
	}
}

type rootIdentityWitness struct {
	application.IdentityOperations
	calls int
}

// The Authentication wrappers have no observable per-instance state. Check
// their binding in New as well as exercising their identity at the HTTP edge.
func TestRootSharedAuthenticationAssembly(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "server.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	var constructor *ast.FuncDecl
	for _, declaration := range file.Decls {
		if fn, ok := declaration.(*ast.FuncDecl); ok && fn.Name.Name == "New" && fn.Recv == nil {
			constructor = fn
		}
	}
	if constructor == nil {
		t.Fatal("server.New not found")
	}
	want := map[string]int{
		"oauthauthorization.NewAuthorizationHTTP": 1,
		"granthttp.RegisterRoutes":                2,
		"projecthttp.NewMembershipRoutes":         1,
		"projecthttp.RegisterRoutes":              2,
		"taghttp.RegisterRoutes":                  2,
		"teamhttp.RegisterRoutes":                 2,
		"workerhttp.RegisterRoutes":               2,
		"prompthttp.RegisterRoutes":               2,
		"workerhttp.NewReadOnlyRoutes":            1,
		"taskhttp.TaskRoutes":                     3,
		"sessionhttp.RegisterInspectionRoutes":    2,
		"sessionhttp.RegisterHistoryRoutes":       2,
		"taskhttp.TaskSearchRoutes":               2,
		"taskhttp.TaskStepsRoutes":                2,
		"taskhttp.TaskThreadRoutes":               2,
		"taskhttp.TaskSyncRoutes":                 2,
		"attachmenthttp.RegisterRoutes":           2,
		"webhookhttp.NewRoutes":                   1,
		"sessionhttp.NewRoutes":                   1,
		"bothttp.RegisterRoutes":                  3,
		"bothttp.RegisterRuntimeRoutes":           3,
	}
	seen := make(map[string]int)
	constructors, authRoutes, authBindings := 0, 0, 0
	ast.Inspect(constructor.Body, func(node ast.Node) bool {
		if assignment, ok := node.(*ast.AssignStmt); ok {
			for i, expression := range assignment.Lhs {
				if id, ok := expression.(*ast.Ident); ok && id.Name == "auth" {
					authBindings++
					if assignment.Tok != token.DEFINE || i != 0 || len(assignment.Rhs) != 1 {
						t.Error("authentication binding was reassigned")
					} else if call, ok := assignment.Rhs[0].(*ast.CallExpr); !ok {
						t.Error("authentication binding is not a constructor call")
					} else if selector, ok := call.Fun.(*ast.SelectorExpr); !ok || selector.Sel.Name != "NewAuthentication" {
						t.Error("authentication binding does not come from NewAuthentication")
					}
				}
			}
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		owner, ok := selector.X.(*ast.Ident)
		if !ok {
			return true
		}
		name := owner.Name + "." + selector.Sel.Name
		if name == "authhttp.NewAuthentication" {
			constructors++
		}
		if name == "auth.RegisterRoutes" {
			authRoutes++
		}
		if index, exists := want[name]; exists {
			seen[name]++
			if len(call.Args) <= index {
				t.Errorf("%s has no authentication argument", name)
			} else if id, ok := call.Args[index].(*ast.Ident); !ok || id.Name != "auth" {
				t.Errorf("%s does not use the shared authentication", name)
			}
		}
		return true
	})
	if constructors != 1 || authRoutes != 1 || authBindings != 1 {
		t.Errorf("Authentication constructors = %d, bindings = %d, auth route registrations = %d; want one each", constructors, authBindings, authRoutes)
	}
	for name := range want {
		if seen[name] != 1 {
			t.Errorf("%s called %d times, want one", name, seen[name])
		}
	}
}

func TestSessionRoutesRetainRequestAuthentication(t *testing.T) {
	auth := &authhttp.Authentication{RequestAuthentication: &authhttp.RequestAuthentication{}}
	relay := sessionhttp.NewRoutes(nil, auth, testLogger())
	got := reflect.ValueOf(relay).Elem().FieldByName("auth")
	if !got.IsValid() || got.Kind() != reflect.Pointer || got.Pointer() != reflect.ValueOf(auth.RequestAuthentication).Pointer() {
		t.Fatal("Session routes did not retain the supplied request authentication")
	}
}

func (w *rootIdentityWitness) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	w.calls++
	return w.IdentityOperations.Authenticate(ctx, kind, token)
}

func rootAssemblyWitness(t *testing.T, withWebhook bool) (*sessionApplication, *service.App, *httpTestStore, *rootIdentityWitness) {
	t.Helper()
	cfg := configuredTestConfig()
	db := newHTTPTestStore(t)
	client, err := service.NewIdentityClient(cfg.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, db, nil, attachmentTestFiles(t), client)
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	witness := &rootIdentityWitness{IdentityOperations: app.Identity}
	app.Identity = witness
	if withWebhook {
		app.Webhooks = &webhookservice.Service{DB: db}
	}
	root, err := New(app, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	h := root.(*sessionApplication)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.BeginShutdown()
		if err := h.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return h, app, db, witness
}

type rootRoute struct {
	method, path, pattern string
	origin                bool
}

func TestRootProtectedRouteRegistration(t *testing.T) {
	root, _, db, witness := rootAssemblyWitness(t, true)
	// Missing credentials must not touch identity or any business store.
	db.WriteIdentityCall = func(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
		t.Error("unauthenticated request reached identity storage")
		return store.Completion{}, model.Unauthenticated(nil)
	}
	const id = "10000000-0000-4000-8000-000000000001"
	const p = "/api/v1/projects/{projectId}"
	const task = p + "/tasks/{taskId}"
	const worker = "/api/v1/me/workers/{workerId}"
	const team = "/api/v1/teams/{teamId}"
	const session = task + "/sessions/{sessionId}"
	const testSession = "/api/v1/test-sessions/{sessionId}"
	var routes []rootRoute
	// The paths here are the literal registered patterns, independent of the
	// actual URL used below. Methodless registrations dispatch inside a handler.
	add := func(methods, path string) {
		for _, method := range strings.Fields(methods) {
			routes = append(routes, rootRoute{method: method, path: path, pattern: method + " " + path})
		}
	}
	addPlain := func(methods, path string) {
		for _, method := range strings.Fields(methods) {
			routes = append(routes, rootRoute{method: method, path: path, pattern: path})
		}
	}
	add("GET", "/api/v1/me")
	add("POST", "/api/v1/auth/logout")
	add("GET POST", "/api/v1/me/tokens")
	add("PATCH DELETE", "/api/v1/me/tokens/{tokenId}")
	for _, op := range []string{"inspect", "decision", "logout"} {
		add("POST", "/api/v1/auth/device/"+op)
	}
	add("GET", "/api/v1/oauth/grants")
	add("GET", "/api/v2/oauth/grants")
	add("POST", "/api/v1/oauth/grants/{id}/revoke")
	addPlain("GET", "/api/v1/oauth/requests/{id}")
	routes = append(routes, rootRoute{method: "POST", path: "/api/v1/oauth/requests/{id}/decision", pattern: "/api/v1/oauth/requests/{id}/decision", origin: true})
	add("GET POST", "/api/v1/projects")
	add("GET DELETE", p)
	for _, op := range []string{"deletion-preview", "access"} {
		add("GET", p+"/"+op)
	}
	for _, op := range []string{"transfer-preview", "transfer"} {
		add("POST", p+"/"+op)
	}
	add("PATCH", p+"/settings")
	add("GET", p+"/members")
	add("PATCH DELETE", p+"/members/{userId}")
	add("PUT DELETE", p+"/grants/{userId}")
	add("GET POST", p+"/invitations")
	add("DELETE", p+"/invitations/{inviteId}")
	for _, op := range []string{"inspect", "accept"} {
		add("POST", "/api/v1/invitations/"+op)
	}
	add("GET POST", "/api/v1/teams")
	add("GET PATCH DELETE", team)
	add("GET POST", team+"/members")
	add("PATCH DELETE", team+"/members/{userId}")
	add("GET POST", team+"/invitations")
	add("DELETE", team+"/invitations/{inviteId}")
	for _, op := range []string{"inspect", "accept"} {
		add("POST", "/api/v1/team-invitations/"+op)
	}
	add("GET", "/api/v1/me/workers")
	add("GET", worker)
	add("POST", "/api/v1/me/workers/monitoring/query")
	for _, op := range []string{"monitoring", "configuration"} {
		add("GET PUT", worker+"/"+op)
	}
	add("POST", worker+"/report")
	add("POST", worker+"/readonly/requests")
	add("GET", worker+"/readonly/channel")
	for _, path := range []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/{projectId}/worker-prompt", worker + "/prompt"} {
		add("GET PUT", path)
	}
	add("GET POST", p+"/tasks")
	add("GET PATCH DELETE", task)
	add("PUT", task+"/status")
	add("POST", p+"/tasks/search")
	for _, op := range []string{"task-work", "task-assignees", "task-graph", "task-sync"} {
		add("GET", p+"/"+op)
	}
	add("GET", "/api/v1/task-properties/schema")
	add("GET", task+"/properties")
	add("PUT DELETE", task+"/properties/{name}")
	add("POST PATCH", task+"/worker-claim")
	for _, op := range []string{"release", "withdraw"} {
		add("POST", task+"/worker-claim/"+op)
	}
	add("GET POST", task+"/steps")
	add("GET PATCH DELETE", task+"/steps/{stepId}")
	for _, op := range []string{"status", "position"} {
		add("PUT", task+"/steps/{stepId}/"+op)
	}
	add("GET POST", task+"/thread/messages")
	add("GET", task+"/attachments")
	add("GET PUT DELETE", task+"/attachments/files/{path...}")
	add("GET", task+"/preview/{path...}")
	add("GET POST", "/api/v1/me/bots")
	add("GET", "/api/v1/me/bots/defaults")
	addPlain("GET DELETE", "/api/v1/me/bots/{botId}")
	add("GET", worker+"/bots")
	for _, op := range []string{"register", "grant", "report", "deletion-complete"} {
		add("POST", worker+"/bots/{botId}/"+op)
	}
	add("GET", "/api/v1/session-capabilities")
	add("GET", "/api/v1/test-session-capabilities")
	add("GET POST", task+"/sessions")
	add("GET", task+"/sessions/current")
	add("POST", session+"/controller-grant")
	for _, op := range []string{"timeline", "channel", "state", "worker-channel", "inspection", "messages", "message-content", "archive/receipt", "archive/state"} {
		add("GET", session+"/"+op)
	}
	for _, op := range []string{"commands", "worker-messages"} {
		add("POST", session+"/"+op)
	}
	for _, op := range []string{"operations/{operationId}", "resources/{resourceId}/content", "recording-evidence/{evidenceId}", "automation-recovery/{recoveryId}"} {
		add("GET", session+"/"+op)
	}
	add("GET POST", "/api/v1/test-sessions")
	add("GET", testSession)
	for _, op := range []string{"controller-grant", "stop", "commands"} {
		add("POST", testSession+"/"+op)
	}
	for _, op := range []string{"timeline", "channel", "operations/{operationId}", "resources/{resourceId}/content"} {
		add("GET", testSession+"/"+op)
	}
	for _, base := range []string{session, testSession} {
		add("GET PUT DELETE", base+"/image-uploads/{uploadId}")
		add("PUT", base+"/image-uploads/{uploadId}/chunks")
		add("POST", base+"/image-uploads/{uploadId}/complete")
		add("GET", base+"/image-capabilities")
		add("GET", base+"/image-occurrences/{imageId}")
		add("POST", base+"/image-occurrences/{imageId}/retry")
		archive := base + "/archive"
		add("GET POST PUT", archive)
		add("GET PUT", archive+"/content")
		add("GET POST", archive+"/prepare")
		add("POST", archive+"/source-tail")
		add("POST", archive+"/seal")
		add("PUT", archive+"/prepare/history/{fileId}")
		add("GET", archive+"/prepare/history/{fileId}/status")
		add("GET PUT", archive+"/files/{fileId}")
		add("GET", archive+"/files/{fileId}/status")
		// Controller token endpoints perform their own credential parsing.
		add("PUT", base+"/image-history-ledger/{fileId}")
		add("GET", base+"/image-history-ledger/{fileId}/status")
	}
	add("GET", "/api/v1/controller-channel")
	add("PUT", "/api/v1/controller-resources/{resourceId}")
	add("GET", "/api/v1/webhook-event-types")
	for _, base := range []string{"/api/v1/me/webhooks", team + "/webhooks"} {
		add("GET POST", base)
		addPlain("GET PATCH DELETE", base+"/{endpointId}")
		// These two resources deliberately share one methodless pattern.
		// Distinct literal request paths exercise its operation/secret dispatch.
		routes = append(routes, rootRoute{method: "GET", path: base + "/operations/{operationId}", pattern: base + "/{endpointId}/{subresource}"})
		routes = append(routes, rootRoute{method: "GET", path: base + "/{endpointId}/signing-secret", pattern: base + "/{endpointId}/{subresource}"})
		add("POST", base+"/{endpointId}/signing-secret/rotations")
		addPlain("GET", base+"/{endpointId}/deliveries")
		addPlain("GET", base+"/{endpointId}/deliveries/{deliveryId}")
		addPlain("GET", base+"/{endpointId}/deliveries/{deliveryId}/attempts")
		addPlain("GET", base+"/{endpointId}/deliveries/{deliveryId}/payload")
		addPlain("POST", base+"/{endpointId}/deliveries/{deliveryId}/redeliveries")
	}
	// Unsupported methods must reach the protected fallback.
	for _, path := range []string{
		"/api/v1/me", "/api/v1/auth/logout", "/api/v1/me/tokens", "/api/v1/me/tokens/{tokenId}",
		"/api/v1/auth/device/inspect", "/api/v1/auth/device/decision", "/api/v1/auth/device/logout",
		"/api/v1/oauth/grants", "/api/v2/oauth/grants", "/api/v1/oauth/grants/{id}/revoke",
		"/api/v1/projects", p, p + "/deletion-preview", p + "/access", p + "/transfer-preview", p + "/transfer", p + "/settings",
		p + "/members", p + "/members/{userId}", p + "/grants/{userId}", p + "/invitations", p + "/invitations/{inviteId}",
		"/api/v1/invitations/inspect", "/api/v1/invitations/accept",
		"/api/v1/teams", team, team + "/members", team + "/members/{userId}", team + "/invitations", team + "/invitations/{inviteId}",
		"/api/v1/team-invitations/inspect", "/api/v1/team-invitations/accept",
		"/api/v1/me/workers", "/api/v1/me/workers/monitoring/query", worker, worker + "/monitoring", worker + "/configuration", worker + "/report",
		worker + "/readonly/requests", worker + "/readonly/channel",
		"/api/v1/me/worker-prompt", "/api/v1/me/projects/{projectId}/worker-prompt", worker + "/prompt",
		p + "/tasks", task, task + "/status", p + "/task-work", p + "/task-assignees", p + "/task-graph", p + "/task-sync",
		"/api/v1/task-properties/schema", task + "/properties", task + "/properties/{name}",
		task + "/worker-claim", task + "/worker-claim/release", task + "/worker-claim/withdraw",
		task + "/steps", task + "/steps/{stepId}", task + "/steps/{stepId}/status", task + "/steps/{stepId}/position", task + "/thread/messages",
		task + "/attachments", task + "/attachments/files/{path...}", task + "/preview/{path...}",
		"/api/v1/me/bots", "/api/v1/me/bots/defaults", "/api/v1/me/bots/{botId}", worker + "/bots",
		worker + "/bots/{botId}/register", worker + "/bots/{botId}/grant", worker + "/bots/{botId}/report", worker + "/bots/{botId}/deletion-complete",
		"/api/v1/session-capabilities", "/api/v1/test-session-capabilities", task + "/sessions", task + "/sessions/current",
		"/api/v1/test-sessions", testSession,
		"/api/v1/webhook-event-types",
	} {
		addPlain("TRACE", path)
	}
	for _, suffix := range []string{
		"/controller-grant", "/timeline", "/commands", "/operations/{operationId}", "/resources/{resourceId}/content", "/channel",
		"/state", "/worker-messages", "/worker-channel", "/archive/receipt", "/archive/state", "/recording-evidence/{evidenceId}", "/automation-recovery/{recoveryId}",
		"/inspection", "/messages", "/message-content",
	} {
		addPlain("TRACE", session+suffix)
	}
	for _, suffix := range []string{
		"/controller-grant", "/stop", "/timeline", "/commands", "/operations/{operationId}", "/resources/{resourceId}/content", "/channel",
	} {
		addPlain("TRACE", testSession+suffix)
	}
	for _, base := range []string{session, testSession} {
		addPlain("TRACE", base+"/archive")
		addPlain("TRACE", base+"/archive/content")
	}
	for _, base := range []string{"/api/v1/me/webhooks", team + "/webhooks"} {
		for _, suffix := range []string{
			"", "/{endpointId}", "/{endpointId}/deliveries", "/{endpointId}/deliveries/{deliveryId}",
			"/{endpointId}/deliveries/{deliveryId}/attempts", "/{endpointId}/deliveries/{deliveryId}/payload",
			"/{endpointId}/deliveries/{deliveryId}/redeliveries", "/{endpointId}/signing-secret/rotations",
		} {
			addPlain("TRACE", base+suffix)
		}
		// The operations and signing-secret branches share one methodless pattern.
		routes = append(routes, rootRoute{method: "TRACE", path: base + "/operations/{operationId}", pattern: base + "/{endpointId}/{subresource}"})
		routes = append(routes, rootRoute{method: "TRACE", path: base + "/{endpointId}/signing-secret", pattern: base + "/{endpointId}/{subresource}"})
	}
	// Search has its own GET/PATCH/DELETE protected fallbacks instead of one
	// methodless registration. GET also matches HEAD in the existing expansion.
	add("GET PATCH DELETE", p+"/tasks/search")
	// Check another unsupported method on the identity endpoint.
	addPlain("DELETE", "/api/v1/me")

	// GET registrations also accept HEAD unless an explicit HEAD route wins.
	// OAuth inspection and the controller channel deliberately reject HEAD
	// without authentication, so their public method fallbacks are excluded.
	var heads []rootRoute
	for _, route := range routes {
		if route.method != "GET" || route.path == "/api/v1/controller-channel" || route.path == "/api/v1/oauth/requests/{id}" {
			continue
		}
		head := rootRoute{method: "HEAD", path: route.path, pattern: route.pattern}
		explicit := route.path == "/api/v1/oauth/grants" || route.path == "/api/v2/oauth/grants" ||
			route.path == worker+"/monitoring" || route.path == worker+"/readonly/channel" ||
			route.path == "/api/v1/session-capabilities" || route.path == "/api/v1/test-session-capabilities" ||
			route.path == "/api/v1/test-sessions" || route.path == testSession ||
			route.path == task+"/sessions/current"
		for _, suffix := range []string{"/timeline", "/channel", "/operations/{operationId}", "/resources/{resourceId}/content"} {
			explicit = explicit || route.path == session+suffix || route.path == testSession+suffix
		}
		for _, suffix := range []string{"/worker-channel", "/archive/receipt", "/archive/state", "/recording-evidence/{evidenceId}", "/automation-recovery/{recoveryId}"} {
			explicit = explicit || route.path == session+suffix
		}
		for _, base := range []string{session, testSession} {
			explicit = explicit || route.path == base+"/archive" || route.path == base+"/archive/content"
		}
		if explicit {
			head.pattern = "HEAD " + route.path
		}
		heads = append(heads, head)
	}
	routes = append(routes, heads...)
	urlFor := strings.NewReplacer(
		"{projectId}", id, "{taskId}", id, "{workerId}", id, "{teamId}", id,
		"{tokenId}", id, "{id}", id, "{userId}", id, "{inviteId}", id,
		"{name}", "name", "{stepId}", "abcdef01", "{path...}", "file",
		"{botId}", id, "{sessionId}", id, "{operationId}", id, "{resourceId}", id,
		"{evidenceId}", id, "{recoveryId}", id, "{uploadId}", id, "{imageId}", id,
		"{fileId}", id, "{endpointId}", id, "{deliveryId}", id,
	)
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			req := httptest.NewRequest(route.method, urlFor.Replace(route.path), nil)
			if route.origin {
				req.Header.Set("Origin", configuredTestConfig().Server.PublicOrigin)
			}
			response := httptest.NewRecorder()
			root.ServeHTTP(response, req)
			if req.Pattern != route.pattern {
				t.Errorf("matched pattern = %q, want %q", req.Pattern, route.pattern)
			}
			if response.Code != http.StatusUnauthorized {
				t.Errorf("got HTTP %d: %s", response.Code, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
			if route.method != "HEAD" && (!strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") || !json.Valid(response.Body.Bytes())) {
				t.Errorf("invalid error response: %q %q", response.Header().Get("Content-Type"), response.Body.String())
			}
		})
	}
	if witness.calls != 0 {
		t.Errorf("credential-less requests reached identity witness %d times", witness.calls)
	}
}

func TestRootSharedIdentityAndSessionEngine(t *testing.T) {
	root, app, db, witness := rootAssemblyWitness(t, false)
	if root.engine != app.Engine || root.service != app.Sessions {
		t.Fatal("Root did not retain the assembled Session instances")
	}
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+defaultHTTPToken())
		w := httptest.NewRecorder()
		root.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/v1/task-properties/schema", "/api/v1/session-capabilities"} {
		w := request(path)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if witness.calls != 2 {
		t.Fatalf("Root HTTP and Session authentication calls = %d, want 2", witness.calls)
	}
	const sessionPath = "/api/v1/projects/10000000-0000-4000-8000-000000000001/tasks/10000000-0000-4000-8000-000000000001/sessions/current"
	writes := 0
	db.WriteSessionCall = func(context.Context, func(store.SessionScope) error) (store.Completion, error) {
		writes++
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("controlled Session store failure")
	}
	if w := request(sessionPath); w.Code != http.StatusInternalServerError || writes != 1 {
		t.Fatalf("live Root Session route did not reach its store: status=%d writes=%d", w.Code, writes)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	w := request(sessionPath)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), `"internal_error"`) || writes != 1 {
		t.Fatalf("stopped shared engine did not reject Root Session route: %d %s", w.Code, w.Body.String())
	}
	_, err := app.Sessions.Current(ctx, defaultHTTPPrincipal(), "10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001")
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "service_unavailable" {
		t.Fatalf("assembled Session did not reject the stopped engine: %v", err)
	}
	if witness.calls != 4 {
		t.Fatalf("identity calls after Session request = %d", witness.calls)
	}
}
