package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type resourceScopeOperations struct {
	t           *testing.T
	identity    *operationHTTPIdentity
	projects    *projectHTTPOperations
	memberships *projectHTTPMembershipOperations
	tasks       *taskHTTPOperations
	attachments *resourceScopeAttachments
	ctx         context.Context
}

func newResourceScopeOperations(t *testing.T) *resourceScopeOperations {
	return &resourceScopeOperations{t: t, identity: &operationHTTPIdentity{t: t}, projects: &projectHTTPOperations{t: t}, memberships: &projectHTTPMembershipOperations{t: t}, tasks: &taskHTTPOperations{t: t}, attachments: &resourceScopeAttachments{t: t}}
}

func resourceScopeServer(t *testing.T, operations *resourceScopeOperations, files filestorage.Storage, output io.Writer) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL = origin, origin+"/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	operations.identity.CallbackURLFn = func() string { return config.UniAuthCallbackURL }
	handler := newOperationHTTPServerWithConfig(t, operations.identity, func(deps *httpDependencies) {
		deps.Projects, deps.Memberships, deps.Tasks, deps.Attachments = operations.projects, operations.memberships, operations.tasks, operations.attachments
	}, output, defaultHTTPPrincipal(), config)
	server.Config.Handler = handler
	server.Start()
	t.Cleanup(server.Close)
	operations.attachments.files = files
	return server
}

func resourceScopeCookie(t *testing.T, browser *http.Client, origin, token string) {
	t.Helper()
	if !secret.Valid(token, "dnst_") {
		t.Fatal("scope fixture requires a canonical session credential")
	}
	address, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	browser.Jar.SetCookies(address, []*http.Cookie{{Name: "daynight_session", Value: token, Path: "/"}})
}

func resourceScopeTaskCopy(task model.Task) model.Task {
	task.Properties = taskproperty.Clone(task.Properties)
	task.DependsOn = slices.Clone(task.DependsOn)
	task.ExternalDependsOn = slices.Clone(task.ExternalDependsOn)
	task.BlockedBy = slices.Clone(task.BlockedBy)
	task.AssignedTo = resourceScopePointer(task.AssignedTo)
	task.RequiredPlatform = resourceScopePointer(task.RequiredPlatform)
	task.StartedAt = resourceScopePointer(task.StartedAt)
	task.CompletedAt = resourceScopePointer(task.CompletedAt)
	task.CancelledAt = resourceScopePointer(task.CancelledAt)
	return task
}
func resourceScopePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func (o *resourceScopeOperations) require(ctx context.Context, actor, expected model.Principal, project, expectedProject string) {
	o.t.Helper()
	if ctx != o.ctx || ctx.Err() != nil || actor != expected || project != expectedProject {
		o.t.Errorf("resource operation context/principal/address: context=%v actor=%+v project=%q; want actor=%+v project=%q", ctx == o.ctx, actor, project, expected, expectedProject)
		panic("resource operation changed request arguments")
	}
}

func resourceScopeAuthentication(t *testing.T, o *resourceScopeOperations, actor model.Principal, token string) {
	resourceScopeAuthenticationResult(t, o, actor, token, true)
}
func resourceScopeAuthenticationResult(t *testing.T, o *resourceScopeOperations, actor model.Principal, token string, allowed bool) {
	t.Helper()
	plan := newHTTPCallPlan(t, map[string]int{"authentication": 1})
	o.identity.AuthenticateFn = func(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		plan.Called("authentication")
		if ctx.Err() != nil || kind != actor.Kind || value != token {
			unexpectedHTTPCall(t, "resource authentication kind/token/context")
		}
		o.ctx = ctx
		if !allowed {
			return model.Principal{}, model.Unauthenticated(nil)
		}
		return actor, nil
	}
}

type resourceScopeAttachments struct {
	t     *testing.T
	files filestorage.Storage
	list  func(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	open  func(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error)
}

func (a *resourceScopeAttachments) List(ctx context.Context, p model.Principal, project, task string, page model.PageRequest) (attachmentcore.Page, error) {
	if a.list == nil {
		unexpectedHTTPCall(a.t, "resource Attachments.List")
	}
	return a.list(ctx, p, project, task, page)
}
func (a *resourceScopeAttachments) Open(ctx context.Context, p model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
	if a.open == nil {
		unexpectedHTTPCall(a.t, "resource Attachments.Open")
	}
	return a.open(ctx, p, project, task, path)
}
func (a *resourceScopeAttachments) PutRetained(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error) {
	unexpectedHTTPCall(a.t, "resource Attachments.PutRetained")
	panic("unreachable")
}
func (a *resourceScopeAttachments) Delete(context.Context, model.Principal, string, string, string) error {
	unexpectedHTTPCall(a.t, "resource Attachments.Delete")
	panic("unreachable")
}

func resourceScopeRead(t *testing.T, o *resourceScopeOperations, actor model.Principal, allowed bool, project model.Project, task model.Task, item model.Attachment, path string) *httpCallPlan {
	t.Helper()
	task = resourceScopeTaskCopy(task)
	base := "/api/v1/projects/" + project.ID
	collection := base + "/tasks"
	taskPath := collection + "/" + task.ID
	plan := newHTTPCallPlan(t, map[string]int{"operation": 1})
	o.projects.GetWithAccessCall = nil
	o.tasks.ObserveCall = nil
	o.tasks.ListCall = nil
	o.tasks.GraphCall = nil
	o.memberships.ListWithAccessCall = nil
	o.memberships.ListInvitationsCall = nil
	o.attachments.list = nil
	o.attachments.open = nil
	check := func(ctx context.Context, p model.Principal, pid string) error {
		plan.Called("operation")
		o.require(ctx, p, actor, pid, project.ID)
		if !allowed {
			return &model.Fault{Code: "not_found", Message: "Project not found."}
		}
		return nil
	}
	switch path {
	case base:
		o.projects.GetWithAccessCall = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
			err := check(ctx, p, id)
			return project, taskHTTPMockAccess(project, actor), err
		}
	case base + "/task-graph?taskId=" + task.ID:
		graph := model.TaskGraph{Project: project, ObservedAt: task.UpdatedAt, Summary: model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}, Tasks: []model.GraphTask{{ID: task.ID, TitlePreview: task.Title, Status: task.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}}
		o.tasks.GraphCall = func(ctx context.Context, p model.Principal, pid, id string) (model.TaskGraph, error) {
			projectHTTPCheck(t, id, task.ID)
			err := check(ctx, p, pid)
			copy := graph
			copy.Tasks = slices.Clone(graph.Tasks)
			for i := range copy.Tasks {
				copy.Tasks[i] = projectHTTPCopyGraphTask(copy.Tasks[i])
			}
			return copy, err
		}
	case collection:
		o.tasks.ListCall = func(ctx context.Context, p model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
			projectHTTPCheck(t, input, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}})
			err := check(ctx, p, pid)
			return taskservice.TaskPage{Items: []model.Task{resourceScopeTaskCopy(task)}}, err
		}
	case taskPath:
		o.tasks.ObserveCall = func(ctx context.Context, p model.Principal, pid, id string) (taskservice.TaskObservation, error) {
			projectHTTPCheck(t, id, task.ID)
			err := check(ctx, p, pid)
			return taskservice.TaskObservation{Task: resourceScopeTaskCopy(task), Epoch: "resource-scope"}, err
		}
	case taskPath + "/attachments":
		o.attachments.list = func(ctx context.Context, p model.Principal, pid, tid string, page model.PageRequest) (attachmentcore.Page, error) {
			projectHTTPCheck(t, tid, task.ID)
			projectHTTPCheck(t, page, model.PageRequest{Limit: 50})
			err := check(ctx, p, pid)
			return attachmentcore.Page{Items: []model.Attachment{item}}, err
		}
	case taskPath + "/attachments/files/" + item.Path, taskPath + "/preview/" + item.Path:
		o.attachments.open = func(ctx context.Context, p model.Principal, pid, tid, path string) (model.Attachment, filestorage.Object, error) {
			projectHTTPCheck(t, []string{tid, path}, []string{task.ID, item.Path})
			if err := check(ctx, p, pid); err != nil {
				return model.Attachment{}, filestorage.Object{}, err
			}
			address, err := attachmentcore.NewAddress(pid, tid, path)
			if err != nil {
				return model.Attachment{}, filestorage.Object{}, err
			}
			object, err := o.attachments.files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
			return item, object, err
		}
	case base + "/members":
		o.memberships.ListWithAccessCall = func(ctx context.Context, p model.Principal, id string) (projectcore.ProjectParticipants, error) {
			err := check(ctx, p, id)
			return projectcore.ProjectParticipants{Items: []model.ProjectParticipant{}, ActorAccess: taskHTTPMockAccess(project, actor)}, err
		}
	case base + "/invitations":
		o.memberships.ListInvitationsCall = func(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
			err := check(ctx, p, id)
			return []model.ProjectInvitation{}, err
		}
	default:
		t.Fatalf("unconfigured root resource: %s", path)
	}
	return plan
}

func TestPrivateProjectResourceHTTPAuthenticationAndScope(t *testing.T) {
	project, task, _ := taskHTTPMockModels()
	project.Name, project.RepoURL = "Private resource scope", "https://example.test/private"
	task.Title, task.AssignedTo = "Private resource", nil
	ownerActor, outsiderActor := identityHTTPPrincipal(identityHTTPUser("alice"), model.SessionCredential), identityHTTPPrincipal(identityHTTPUser("bob"), model.SessionCredential)
	files := attachmentTestFiles(t)
	address, err := attachmentcore.NewAddress(project.ID, task.ID, "private.html")
	if err != nil {
		t.Fatal(err)
	}
	const content = "<p>private content</p>"
	if info, err := files.Put(t.Context(), attachmentcore.Bucket, address.StoragePath, strings.NewReader(content)); err != nil || info.Size != int64(len(content)) {
		t.Fatalf("scope content fixture: %+v %v", info, err)
	}
	item := model.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: "private.html", ContentType: "text/html", SizeBytes: int64(len(content)), CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}
	operations := newResourceScopeOperations(t)
	server := resourceScopeServer(t, operations, files, io.Discard)
	owner, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	ownerToken, outsiderToken := httpTestToken(model.SessionCredential), "dnst_"+strings.Repeat("B", 42)+"A"
	resourceScopeCookie(t, owner, server.URL, ownerToken)
	resourceScopeCookie(t, outsider, server.URL, outsiderToken)
	base := "/api/v1/projects/" + project.ID
	file, preview := base+"/tasks/"+task.ID+"/attachments/files/private.html", base+"/tasks/"+task.ID+"/preview/private.html"
	paths := []string{base, base + "/task-graph?taskId=" + task.ID, base + "/tasks", base + "/tasks/" + task.ID, base + "/tasks/" + task.ID + "/attachments", file, preview, base + "/members", base + "/invitations"}
	for _, path := range paths {
		resourceScopeAuthentication(t, operations, ownerActor, ownerToken)
		plan := resourceScopeRead(t, operations, ownerActor, true, project, task, item, path)
		_, body := identityRequest(t, owner, http.MethodGet, server.URL+path, "", nil, http.StatusOK)
		if (path == file || path == preview) && string(body) != content {
			t.Fatalf("private bytes: %s", body)
		}
		plan.Verify()
		for _, test := range []struct {
			name   string
			client *http.Client
			actor  model.Principal
			token  string
			status int
			code   string
		}{{"nonmember", outsider, outsiderActor, outsiderToken, http.StatusNotFound, "not_found"}, {"anonymous", anonymous, model.Principal{}, "", http.StatusUnauthorized, "unauthenticated"}} {
			t.Run(test.name+"/"+path, func(t *testing.T) {
				if test.token != "" {
					resourceScopeAuthentication(t, operations, test.actor, test.token)
					resourceScopeRead(t, operations, test.actor, false, project, task, item, path)
				}
				response, body := identityRequest(t, test.client, http.MethodGet, server.URL+path, "", nil, test.status)
				mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
				if err != nil || mediaType != "application/json" {
					t.Fatalf("denial content type: %q, %v", response.Header.Get("Content-Type"), err)
				}
				var envelope api.ErrorResponse
				if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != test.code {
					t.Fatalf("denial envelope: %s, %v", body, err)
				}
			})
		}
	}
	resourceScopeAuthentication(t, operations, ownerActor, ownerToken)
	resourceScopeRead(t, operations, ownerActor, true, project, task, item, preview)
	_, ownerHead := identityRequest(t, owner, http.MethodHead, server.URL+preview, "", nil, http.StatusOK)
	if len(ownerHead) != 0 {
		t.Fatal("authorized preview HEAD returned a body")
	}
	for _, test := range []struct {
		name   string
		client *http.Client
		status int
	}{{"nonmember", outsider, http.StatusNotFound}, {"anonymous", anonymous, http.StatusUnauthorized}} {
		t.Run(test.name+"/preview-head", func(t *testing.T) {
			if test.name == "nonmember" {
				resourceScopeAuthentication(t, operations, outsiderActor, outsiderToken)
				resourceScopeRead(t, operations, outsiderActor, false, project, task, item, preview)
			}
			response, body := identityRequest(t, test.client, http.MethodHead, server.URL+preview, "", nil, test.status)
			mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" || len(body) != 0 {
				t.Fatalf("HEAD denial: type=%q bytes=%d error=%v", response.Header.Get("Content-Type"), len(body), err)
			}
		})
	}
}

func resourceScopeCreate(t *testing.T, o *resourceScopeOperations, p model.Principal, name, repo, team string, explicit bool) {
	t.Helper()
	if explicit {
		t.Fatal("resource scope creates personal Projects")
	}
	expected := projectcore.CreateProject{Name: name, RepoURL: repo, ExpectedUserID: p.UserID}
	project := projectHTTPRecord(uuid.NewString(), name, repo, team)
	access := projectHTTPAccess(p, project)
	plan := newHTTPCallPlan(t, map[string]int{"CreateWithAccess": 1})
	o.projects.CreateWithAccessCall = func(ctx context.Context, actor model.Principal, input projectcore.CreateProject) (model.Project, model.ProjectAccess, error) {
		plan.Called("CreateWithAccess")
		o.require(ctx, actor, p, "", "")
		projectHTTPCheck(t, input, expected)
		return project, projectHTTPCopyAccess(access), nil
	}
}
func resourceScopeProjectPage(t *testing.T, o *resourceScopeOperations, p model.Principal, items []model.Project) {
	t.Helper()
	expected := slices.Clone(items)
	plan := newHTTPCallPlan(t, map[string]int{"ListScoped": 1})
	o.projects.ListScopedCall = func(ctx context.Context, actor model.Principal, input projectcore.ProjectListRequest) (projectcore.ProjectPage, error) {
		plan.Called("ListScoped")
		o.require(ctx, actor, p, "", "")
		projectHTTPCheck(t, input, projectcore.ProjectListRequest{Page: model.PageRequest{Limit: 50}})
		return projectcore.ProjectPage{Items: slices.Clone(expected)}, nil
	}
}

func TestPrivateProjectListsRemainIsolatedAcrossPATs(t *testing.T) {
	operations := newResourceScopeOperations(t)
	logs := &identityIntegrationLogs{}
	server := resourceScopeServer(t, operations, attachmentTestFiles(t), logs)
	alice, bob := identityBrowser(t), identityBrowser(t)
	aliceUser, bobUser := identityHTTPUser("alice"), identityHTTPUser("bob")
	if aliceUser.ID == bobUser.ID {
		t.Fatal("fixture identities are not distinct")
	}
	resourceScopeCookie(t, alice, server.URL, httpTestToken(model.SessionCredential))
	resourceScopeCookie(t, bob, server.URL, "dnst_"+strings.Repeat("B", 42)+"A")
	session := func(browser *http.Client, user model.User) {
		resourceScopeAuthentication(t, operations, identityHTTPPrincipal(user, model.SessionCredential), identityCookie(t, browser, server.URL, "daynight_session"))
	}
	origin := map[string]string{"Origin": server.URL}
	bobActor := identityHTTPPrincipal(bobUser, model.SessionCredential)
	session(bob, bobUser)
	resourceScopeCreate(t, operations, bobActor, "Bob private project", "https://example.test/bob", bobUser.PersonalTeam.ID, false)
	_, data := identityRequest(t, bob, http.MethodPost, server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Bob private project", RepoURL: "https://example.test/bob", ExpectedUserID: bobUser.ID}), origin, http.StatusCreated)
	bobProject := identityDecode[api.Project](t, data)
	mint := func(browser *http.Client, user model.User, name string) api.CreatedPersonalAccessToken {
		t.Helper()
		session(browser, user)
		secretValue := secret.Random("dnpat_")
		draft := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, Name: name, TokenHash: secret.Hash(secretValue), CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
		expected := draft
		expected.TokenHash = bytes.Clone(draft.TokenHash)
		call := newHTTPCallPlan(t, map[string]int{"CreatePAT": 1})
		operations.identity.CreatePATFn = func(ctx context.Context, p model.Principal, input identitycore.CreatePAT) (identitycore.MintedPAT, error) {
			call.Called("CreatePAT")
			operations.require(ctx, p, identityHTTPPrincipal(user, model.SessionCredential), "", "")
			projectHTTPCheck(t, input, identitycore.CreatePAT{Name: name, ExpiresAt: nil})
			output := expected
			output.TokenHash = bytes.Clone(expected.TokenHash)
			output.ExpiresAt = resourceScopePointer(expected.ExpiresAt)
			return identitycore.MintedPAT{Credential: output, Secret: secretValue}, nil
		}
		_, body := identityRequest(t, browser, http.MethodPost, server.URL+"/api/v1/me/tokens", jsonBody(t, map[string]any{"name": name, "expiresAt": nil}), origin, http.StatusCreated)
		created := identityDecode[api.CreatedPersonalAccessToken](t, body)
		if created.ID == "" || !strings.HasPrefix(created.Token, "dnpat_") || created.ID != draft.ID || !bytes.Equal(draft.TokenHash, secret.Hash(created.Token)) {
			t.Fatal("PAT creation did not return its proposed credential")
		}
		want := api.CreatedPersonalAccessToken{PersonalAccessToken: api.PersonalAccessToken{ID: expected.ID, Name: expected.Name, CreatedAt: expected.CreatedAt, ExpiresAt: resourceScopePointer(expected.ExpiresAt)}, Token: secretValue}
		if !reflect.DeepEqual(created, want) {
			t.Fatalf("complete PAT response: got %+v, want %+v", created, want)
		}
		return created
	}
	aliceToken, bobToken := mint(alice, aliceUser, "Alice project access"), mint(bob, bobUser, "Bob project access")
	alicePAT, bobPAT := identityBrowser(t), identityBrowser(t)
	aliceBearer, bobBearer := map[string]string{"Authorization": "Bearer " + aliceToken.Token}, map[string]string{"Authorization": "Bearer " + bobToken.Token}
	list := func(client *http.Client, bearer map[string]string, user model.User, project api.Project) api.ProjectPage {
		t.Helper()
		resourceScopeAuthentication(t, operations, identityHTTPPrincipal(user, model.PATCredential), strings.TrimPrefix(bearer["Authorization"], "Bearer "))
		stored := projectHTTPRecord(project.ID, project.Name, project.RepoURL, project.Ownership.TeamID)
		resourceScopeProjectPage(t, operations, identityHTTPPrincipal(user, model.PATCredential), []model.Project{stored})
		response, body := identityRequest(t, client, http.MethodGet, server.URL+"/api/v1/projects", "", bearer, http.StatusOK)
		if response.Header.Get("Daynight-User-ID") != user.ID {
			t.Fatal("PAT project response lost its authenticated identity")
		}
		return identityDecode[api.ProjectPage](t, body)
	}
	bobBefore := list(bobPAT, bobBearer, bobUser, bobProject)
	if len(bobBefore.Items) != 1 || bobBefore.Items[0] != bobProject || bobBefore.NextCursor != nil {
		t.Fatalf("Bob's initial project scope: %+v", bobBefore)
	}
	resourceScopeAuthentication(t, operations, identityHTTPPrincipal(aliceUser, model.PATCredential), aliceToken.Token)
	resourceScopeCreate(t, operations, identityHTTPPrincipal(aliceUser, model.PATCredential), "Alice private project", "https://example.test/alice", aliceUser.PersonalTeam.ID, false)
	_, data = identityRequest(t, alicePAT, http.MethodPost, server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Alice private project", RepoURL: "https://example.test/alice", ExpectedUserID: aliceUser.ID}), aliceBearer, http.StatusCreated)
	aliceProject := identityDecode[api.Project](t, data)
	alicePage := list(alicePAT, aliceBearer, aliceUser, aliceProject)
	if len(alicePage.Items) != 1 || alicePage.Items[0] != aliceProject || alicePage.Items[0].ID == bobProject.ID || alicePage.NextCursor != nil {
		t.Fatalf("Alice's PAT project scope: %+v", alicePage)
	}
	bobAfter := list(bobPAT, bobBearer, bobUser, bobProject)
	if !reflect.DeepEqual(bobAfter, bobBefore) {
		t.Fatalf("Alice's project creation changed Bob's scope: %+v", bobAfter)
	}
	session(alice, aliceUser)
	revoke := newHTTPCallPlan(t, map[string]int{"RevokePAT": 1})
	operations.identity.RevokePATFn = func(ctx context.Context, p model.Principal, id string) error {
		revoke.Called("RevokePAT")
		operations.require(ctx, p, identityHTTPPrincipal(aliceUser, model.SessionCredential), "", "")
		projectHTTPCheck(t, id, aliceToken.ID)
		return nil
	}
	identityRequest(t, alice, http.MethodDelete, server.URL+"/api/v1/me/tokens/"+aliceToken.ID, "", origin, http.StatusNoContent)
	resourceScopeAuthenticationResult(t, operations, identityHTTPPrincipal(aliceUser, model.PATCredential), aliceToken.Token, false)
	identityRequest(t, alicePAT, http.MethodGet, server.URL+"/api/v1/projects", "", aliceBearer, http.StatusUnauthorized)
	if afterRevocation := list(bobPAT, bobBearer, bobUser, bobProject); !reflect.DeepEqual(afterRevocation, bobBefore) {
		t.Fatal("Alice's PAT revocation changed Bob's access")
	}
	if logs.contains(aliceToken.Token) || logs.contains(bobToken.Token) {
		t.Fatal("project request diagnostics exposed a PAT")
	}
}
