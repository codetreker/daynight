package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestProjectAccessHTTPProjectionAuthorizationAndMethods(t *testing.T) {
	admin := defaultHTTPPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	outsider := model.Principal{UserID: "f6666666-6666-4666-8666-666666666666", CredentialID: "a7777777-7777-4777-8777-777777777777", Kind: model.PATCredential}
	project := projectHTTPRecord("a8888888-8888-4888-8888-888888888888", "Access projection", "https://example.test/access.git", "b9999999-9999-4999-8999-999999999999")
	var logs bytes.Buffer
	adminTx := newProjectAccessHTTPFixture(t, admin, &logs)
	adminHandler := adminTx.handler
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
			tx = newProjectAccessHTTPFixture(t, test.principal, &logs)
			handler = tx.handler
		}
		expected := projectHTTPAccess(test.principal, project)
		expected.Role = test.role
		expected.DirectGrant.Role = test.role
		expected.DirectGrant.Version = test.version
		if test.role != model.ProjectAdmin {
			expected.TeamRole = nil
			expected.CanTransfer = false
		}
		accessHTTPProject(t, tx, test.principal, project, expected, "access", taskservice.TaskSyncRequest{}, nil)
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
		accessHTTPProject(t, tx, test.principal, project, expected, "sync", taskservice.TaskSyncRequest{}, nil, "snapshot")
		snapshot := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
		since := time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
		accessHTTPProject(t, tx, test.principal, project, expected, "sync", taskservice.TaskSyncRequest{Epoch: snapshot.Epoch, Since: &since}, nil, "delta")
		deltaResponse := projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", "")
		delta := decodeResponse[api.TaskSync](t, deltaResponse, http.StatusOK)
		if !reflect.DeepEqual(snapshot.ActorAccess, access) || !reflect.DeepEqual(delta.ActorAccess, access) || delta.Mode != "delta" || delta.Tasks == nil || len(delta.Tasks) != 0 || !strings.Contains(deltaResponse.Body.String(), `"actorAccess":`) {
			t.Fatalf("actor projection missing from empty sync: %#v %#v", snapshot, delta)
		}
	}
	unauthenticated := projectRequest(adminHandler.Handler, http.MethodGet, path, "")
	assertProjectError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
	if unauthenticated.Header().Get("Daynight-User-ID") != "" {
		t.Fatal("unauthenticated response exposes an actor")
	}
	outsiderTx := newProjectAccessHTTPFixture(t, outsider, &logs)
	outsiderHandler := outsiderTx.handler
	accessHTTPRefusal(t, outsiderTx, outsider, project.ID, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	assertProjectError(t, projectRequest(outsiderHandler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(adminHandler, http.MethodGet, "/api/v1/projects/invalid/access", ""), http.StatusBadRequest, "invalid_input")
	const missing = "00000000-0000-4000-8000-000000000099"
	accessHTTPRefusal(t, adminTx, admin, missing, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	assertProjectError(t, projectRequest(adminHandler, http.MethodGet, "/api/v1/projects/"+missing+"/access", ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(adminHandler, http.MethodGet, path+"?unknown=secret", ""), http.StatusBadRequest, "invalid_input")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(adminHandler, method, path, "private-body-secret")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != admin.UserID {
			t.Fatalf("method boundary: %#v", response.Header())
		}
	}
	expected := projectHTTPAccess(admin, project)
	expected.DirectGrant.Version = 9007199254740993
	accessHTTPProject(t, adminTx, admin, project, expected, "access", taskservice.TaskSyncRequest{}, nil)
	server := httptest.NewServer(adminHandler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+adminHandler.token)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	server.Close()
	if readErr != nil || closeErr != nil || len(body) != 0 || response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != admin.UserID {
		t.Fatalf("HEAD actor access: %#v %s %v %v", response, body, readErr, closeErr)
	}
	accessHTTPRefusal(t, adminTx, admin, project.ID, &store.Error{Phase: "project access", DatabaseFailure: true, Cause: io.ErrUnexpectedEOF})
	assertProjectError(t, projectRequest(adminHandler, http.MethodGet, path, ""), http.StatusInternalServerError, "internal_error")
	if strings.Contains(logs.String(), "private-body-secret") || strings.Contains(logs.String(), "unknown=secret") {
		t.Fatal("access diagnostics exposed request contents")
	}
}

func TestOwnershipProjectionExactVersionsAcrossCurrentReaders(t *testing.T) {
	actor := defaultHTTPPrincipal()
	var logs bytes.Buffer
	tx := newProjectAccessHTTPFixture(t, actor, &logs)
	handler := tx.handler
	project := projectHTTPRecord("a8888888-8888-4888-8888-888888888888", "Ownership projection", "https://example.test/ownership.git", "b9999999-9999-4999-8999-999999999999")
	project.Ownership.Version = 9007199254740993
	expected := projectHTTPAccess(actor, project)
	user := model.User{ID: actor.UserID, UniAuthID: "fixture-owner", CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, PersonalTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"}}
	accessHTTPUser(t, tx, actor, user, nil)
	me := decodeResponse[api.User](t, projectRequest(handler, "GET", "/api/v1/me", ""), 200)
	if me.PersonalTeam.ID != project.Ownership.TeamID || me.PersonalTeam.Kind != "personal" || me.PersonalTeam.Name != nil {
		t.Fatalf("Personal reference: %#v", me)
	}
	base := "/api/v1/projects/" + project.ID
	accessHTTPProject(t, tx, actor, project, expected, "project", taskservice.TaskSyncRequest{}, nil)
	response := projectRequest(handler, "GET", base, "")
	document := decodeResponse[api.ProjectDocument](t, response, 200)
	if document.Ownership.TeamID != me.PersonalTeam.ID || document.Ownership.Version != 9007199254740993 || document.Access.Ownership != document.Ownership || document.Access.OwnerTeam != me.PersonalTeam || document.Access.TeamRole == nil || *document.Access.TeamRole != "admin" || !document.Access.CanTransfer || !strings.Contains(response.Body.String(), `"version":9007199254740993`) {
		t.Fatalf("Project ownership/access: %s", response.Body)
	}
	accessHTTPProject(t, tx, actor, project, expected, "list", taskservice.TaskSyncRequest{}, nil)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, "GET", "/api/v1/projects", ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "sync", taskservice.TaskSyncRequest{}, nil, "snapshot")
	snapshot := decodeResponse[api.TaskSync](t, projectRequest(handler, "GET", base+"/task-sync", ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "sync", taskservice.TaskSyncRequest{Epoch: snapshot.Epoch}, nil, "delta")
	delta := decodeResponse[api.TaskSync](t, projectRequest(handler, "GET", base+"/task-sync?epoch="+snapshot.Epoch, ""), 200)
	accessHTTPProject(t, tx, actor, project, expected, "members", taskservice.TaskSyncRequest{}, nil)
	people := decodeResponse[api.ProjectParticipantList](t, projectRequest(handler, "GET", base+"/members", ""), 200)
	if len(page.Items) != 1 || page.Items[0] != document.Project || snapshot.Project != document.Project || delta.Project != document.Project || !reflect.DeepEqual(snapshot.ActorAccess, document.Access) || !reflect.DeepEqual(people.ActorAccess, document.Access) || len(people.Items) != 1 || people.Items[0].InheritedFrom == nil || people.Items[0].InheritedFrom.Team != me.PersonalTeam || people.Items[0].InheritedFrom.Role != "admin" {
		t.Fatalf("current-reader divergence: %#v %#v %#v %#v", page, snapshot, delta, people)
	}
	task := model.GraphTask{ID: "caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TitlePreview: "Ownership graph", Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
	accessHTTPProject(t, tx, actor, project, expected, "graph", taskservice.TaskSyncRequest{}, &task)
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
	accessHTTPUser(t, tx, actor, model.User{}, errors.New("user Personal Team is missing or invalid"))
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me", ""), 500, "internal_error")
}
