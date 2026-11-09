package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type resourceScopeAttachmentReader struct {
	store.AttachmentReader
	t    *testing.T
	plan *httpCallPlan
	item model.Attachment
}

func (r resourceScopeAttachmentReader) Attachment(_ context.Context, project, task, path string) (model.Attachment, error) {
	r.plan.Called("metadata")
	projectHTTPCheck(r.t, []string{project, task, path}, []string{r.item.ProjectID, r.item.TaskID, r.item.Path})
	return r.item, nil
}

func (r resourceScopeAttachmentReader) Attachments(_ context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	r.plan.Called("attachments")
	projectHTTPCheck(r.t, []string{project, task}, []string{r.item.ProjectID, r.item.TaskID})
	projectHTTPCheck(r.t, query, store.AttachmentQuery{Limit: 1, MaxPathBytes: attachmentcore.MaxMetadataPageResponseJSONBytes, MaxFieldBytes: attachmentcore.MaxMetadataPageResponseJSONBytes})
	return store.AttachmentPage{Items: []model.Attachment{r.item}}, nil
}

func resourceScopeServer(t *testing.T, tx store.Transactions, files filestorage.Storage, output io.Writer) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL = origin, origin+"/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: tx, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		handler.(Handler).BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(Handler).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
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

func resourceScopeRead(t *testing.T, tx *httpTestStore, actor model.Principal, allowed bool, project model.Project, task model.Task, item model.Attachment, path string) *httpCallPlan {
	t.Helper()
	base := "/api/v1/projects/" + project.ID
	collection := base + "/tasks"
	taskPath := collection + "/" + task.ID
	want := map[string]int{"snapshot": 1, "access": 1}
	if allowed {
		switch path {
		case base:
			want["project"] = 1
		case base + "/task-graph?taskId=" + task.ID:
			want["project"], want["presence"], want["size"], want["graph"], want["observed"] = 1, 1, 1, 1, 1
		case collection:
			want["tasks"] = 1
		case taskPath:
			want["task"], want["epoch"] = 1, 1
		case taskPath + "/attachments":
			want["presence"], want["attachments"] = 1, 1
		case taskPath + "/attachments/files/" + item.Path, taskPath + "/preview/" + item.Path:
			want["presence"], want["metadata"] = 1, 1
		case base + "/members":
			want["participants"] = 1
		case base + "/invitations":
			want["invitations"] = 1
		default:
			t.Fatalf("unconfigured root resource: %s", path)
		}
	}
	plan := newHTTPCallPlan(t, want)
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "resource.Project"), ProjectAccessFn: func(_ context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		plan.Called("access")
		projectHTTPCheck(t, principal, actor)
		projectHTTPCheck(t, id, project.ID)
		if !allowed {
			return model.ProjectAccess{}, model.ErrNotFound
		}
		return taskHTTPMockAccess(project, actor), nil
	}, ProjectFn: func(_ context.Context, id string) (model.Project, error) {
		plan.Called("project")
		projectHTTPCheck(t, id, project.ID)
		return project, nil
	}, ProjectParticipantsFn: func(_ context.Context, id string) ([]model.ProjectParticipant, error) {
		plan.Called("participants")
		projectHTTPCheck(t, id, project.ID)
		return []model.ProjectParticipant{}, nil
	}, InvitationsFn: func(_ context.Context, id string, now time.Time) ([]model.ProjectInvitation, error) {
		plan.Called("invitations")
		projectHTTPCheck(t, id, project.ID)
		identityHTTPNow(t, now)
		return []model.ProjectInvitation{}, nil
	}}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, IncludeExternalEdges: true, LiveOnly: true}
	tasks := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "resource.Task"), TaskFn: func(_ context.Context, projectID, id string) (model.Task, error) {
		plan.Called("task")
		projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
		return resourceScopeTaskCopy(task), nil
	}, TasksFn: func(_ context.Context, id string, query store.TaskQuery) (store.TaskPage, error) {
		plan.Called("tasks")
		projectHTTPCheck(t, id, project.ID)
		projectHTTPCheck(t, query, store.TaskQuery{Page: store.Page{Limit: 1}, BoundedText: true, LegacyProjection: true})
		return store.TaskPage{Items: []model.Task{resourceScopeTaskCopy(task)}}, nil
	}, TaskPresenceFn: func(_ context.Context, projectID, id string) (store.TaskPresence, error) {
		plan.Called("presence")
		projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
		return store.TaskPresence{Found: true}, nil
	}, TaskCacheEpochFn: func(_ context.Context, id string) (string, error) {
		plan.Called("epoch")
		projectHTTPCheck(t, id, project.ID)
		return "resource-scope", nil
	},
		TaskGraphProjectionSizeFn: func(_ context.Context, projectID, id string, got store.TaskGraphSelection) (store.TaskGraphSize, error) {
			plan.Called("size")
			projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
			projectHTTPCheck(t, got, selection)
			return store.TaskGraphSize{NodeCount: 1}, nil
		},
		TaskGraphTasksFn: func(_ context.Context, projectID, id string, got store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
			plan.Called("graph")
			projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
			projectHTTPCheck(t, got, selection)
			projectHTTPCheck(t, characters, projection.TitlePreviewCharacters)
			return []model.GraphTask{{ID: task.ID, TitlePreview: task.Title, Status: task.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}, nil
		}}
	snapshot := newHTTPTestSnapshot(t)
	snapshot.Projects, snapshot.Tasks, snapshot.Attachments = projects, tasks, resourceScopeAttachmentReader{t: t, plan: plan, item: item}
	snapshot.ObservedAtCall = func(context.Context) (time.Time, error) { plan.Called("observed"); return task.UpdatedAt, nil }
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		return fn(snapshot)
	}
	return plan
}

func resourceScopeAuthentication(t *testing.T, tx *httpTestStore, actor model.Principal, token string) {
	t.Helper()
	plan := newHTTPCallPlan(t, map[string]int{"authentication": 1})
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		plan.Called("authentication")
		dao := &httpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, principal: actor, hash: secret.Hash(token)}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			unexpectedHTTPCall(t, "root authentication callback")
		}
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
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
	tx := newHTTPTestStore(t)
	server := resourceScopeServer(t, tx, files, io.Discard)
	owner, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	ownerToken, outsiderToken := httpTestToken(model.SessionCredential), "dnst_"+strings.Repeat("B", 42)+"A"
	resourceScopeCookie(t, owner, server.URL, ownerToken)
	resourceScopeCookie(t, outsider, server.URL, outsiderToken)
	base := "/api/v1/projects/" + project.ID
	file, preview := base+"/tasks/"+task.ID+"/attachments/files/private.html", base+"/tasks/"+task.ID+"/preview/private.html"
	paths := []string{base, base + "/task-graph?taskId=" + task.ID, base + "/tasks", base + "/tasks/" + task.ID, base + "/tasks/" + task.ID + "/attachments", file, preview, base + "/members", base + "/invitations"}
	for _, path := range paths {
		resourceScopeAuthentication(t, tx, ownerActor, ownerToken)
		plan := resourceScopeRead(t, tx, ownerActor, true, project, task, item, path)
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
					resourceScopeAuthentication(t, tx, test.actor, test.token)
					resourceScopeRead(t, tx, test.actor, false, project, task, item, path)
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
	resourceScopeAuthentication(t, tx, ownerActor, ownerToken)
	resourceScopeRead(t, tx, ownerActor, true, project, task, item, preview)
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
				resourceScopeAuthentication(t, tx, outsiderActor, outsiderToken)
				resourceScopeRead(t, tx, outsiderActor, false, project, task, item, preview)
			}
			response, body := identityRequest(t, test.client, http.MethodHead, server.URL+preview, "", nil, test.status)
			mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" || len(body) != 0 {
				t.Fatalf("HEAD denial: type=%q bytes=%d error=%v", response.Header.Get("Content-Type"), len(body), err)
			}
		})
	}
}

func TestPrivateProjectListsRemainIsolatedAcrossPATs(t *testing.T) {
	tx, plan := newIdentityHTTPPlan(t)
	logs := &identityIntegrationLogs{}
	server := resourceScopeServer(t, tx, attachmentTestFiles(t), logs)
	alice, bob := identityBrowser(t), identityBrowser(t)
	aliceUser, bobUser := identityHTTPUser("alice"), identityHTTPUser("bob")
	if aliceUser.ID == bobUser.ID {
		t.Fatal("fixture identities are not distinct")
	}
	resourceScopeCookie(t, alice, server.URL, httpTestToken(model.SessionCredential))
	resourceScopeCookie(t, bob, server.URL, "dnst_"+strings.Repeat("B", 42)+"A")
	integration := &identityIntegration{plan: plan, server: server, logs: logs, sessionCookie: "daynight_session"}
	origin := map[string]string{"Origin": server.URL}
	bobActor := identityHTTPPrincipal(bobUser, model.SessionCredential)
	integration.session(t, bob, bobUser)
	projectHTTPCreate(t, tx, bobActor, "Bob private project", "https://example.test/bob", bobUser.PersonalTeam.ID, false)
	_, data := identityRequest(t, bob, http.MethodPost, server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Bob private project", RepoURL: "https://example.test/bob", ExpectedUserID: bobUser.ID}), origin, http.StatusCreated)
	bobProject := identityDecode[api.Project](t, data)
	mint := func(browser *http.Client, user model.User, name string) api.CreatedPersonalAccessToken {
		t.Helper()
		integration.session(t, browser, user)
		var draft model.PersonalAccessToken
		plan.expect(integration.lockSession(identityHTTPPrincipal(user, model.SessionCredential)), identityHTTPCall{"CleanupCredentials", func(args []any) any { identityHTTPNow(t, args[1].(time.Time)); return nil }}, identityHTTPCall{"InsertPAT", func(args []any) any {
			draft = args[1].(model.PersonalAccessToken)
			if draft.UserID != user.ID || draft.Name != name || draft.ExpiresAt != nil {
				unexpectedHTTPCall(t, "private PAT draft")
			}
			return nil
		}})
		_, body := identityRequest(t, browser, http.MethodPost, server.URL+"/api/v1/me/tokens", jsonBody(t, map[string]any{"name": name, "expiresAt": nil}), origin, http.StatusCreated)
		created := identityDecode[api.CreatedPersonalAccessToken](t, body)
		if created.ID == "" || !strings.HasPrefix(created.Token, "dnpat_") || created.ID != draft.ID || !bytes.Equal(draft.TokenHash, secret.Hash(created.Token)) {
			t.Fatal("PAT creation did not return its proposed credential")
		}
		return created
	}
	aliceToken, bobToken := mint(alice, aliceUser, "Alice project access"), mint(bob, bobUser, "Bob project access")
	alicePAT, bobPAT := identityBrowser(t), identityBrowser(t)
	aliceBearer, bobBearer := map[string]string{"Authorization": "Bearer " + aliceToken.Token}, map[string]string{"Authorization": "Bearer " + bobToken.Token}
	list := func(client *http.Client, bearer map[string]string, user model.User, project api.Project) api.ProjectPage {
		t.Helper()
		plan.authenticate(user, model.PATCredential, strings.TrimPrefix(bearer["Authorization"], "Bearer "), true)
		stored := projectHTTPRecord(project.ID, project.Name, project.RepoURL, project.Ownership.TeamID)
		projectHTTPPage(t, tx, identityHTTPPrincipal(user, model.PATCredential), projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 1}, []model.Project{stored}, false)
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
	plan.authenticate(aliceUser, model.PATCredential, aliceToken.Token, true)
	projectHTTPCreate(t, tx, identityHTTPPrincipal(aliceUser, model.PATCredential), "Alice private project", "https://example.test/alice", aliceUser.PersonalTeam.ID, false)
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
	integration.session(t, alice, aliceUser)
	plan.expect(integration.lockSession(identityHTTPPrincipal(aliceUser, model.SessionCredential)), identityHTTPCall{"DeletePAT", func(args []any) any {
		projectHTTPCheck(t, []string{args[1].(string), args[2].(string)}, []string{aliceUser.ID, aliceToken.ID})
		return nil
	}})
	identityRequest(t, alice, http.MethodDelete, server.URL+"/api/v1/me/tokens/"+aliceToken.ID, "", origin, http.StatusNoContent)
	plan.authenticate(aliceUser, model.PATCredential, aliceToken.Token, false)
	identityRequest(t, alicePAT, http.MethodGet, server.URL+"/api/v1/projects", "", aliceBearer, http.StatusUnauthorized)
	if afterRevocation := list(bobPAT, bobBearer, bobUser, bobProject); !reflect.DeepEqual(afterRevocation, bobBefore) {
		t.Fatal("Alice's PAT revocation changed Bob's access")
	}
	if logs.contains(aliceToken.Token) || logs.contains(bobToken.Token) {
		t.Fatal("project request diagnostics exposed a PAT")
	}
}
