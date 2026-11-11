package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

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
