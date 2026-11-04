package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func TestProjectAccessHTTPProjectionAuthorizationAndMethods(t *testing.T) {
	h := membershipTestHarness(t)
	_, token := h.invitation(t)
	decodeResponse[api.ProjectMember](t, h.call(http.MethodPost, "/api/v1/invitations/accept", invitationBody(token), h.member), http.StatusOK)
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE project_grants SET version=9007199254740993 WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.adminID); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	projectRoutes(mux, service.NewProjects(h.database), h.auth, logger)
	taskSyncRoutes(mux, service.NewTaskSync(h.database, 10*time.Second), h.auth, logger, 10*time.Second)
	h.handler = RequestLogging(logger, mux)
	path := "/api/v1/projects/" + strings.ToUpper(h.project.ID) + "/access"
	for _, test := range []struct {
		cookie *http.Cookie
		userID string
		role   string
	}{
		{h.admin, h.adminID, "admin"},
		{h.member, h.memberID, "member"},
	} {
		response := h.call(http.MethodGet, path, "", test.cookie)
		access := decodeResponse[api.ProjectAccess](t, response, http.StatusOK)
		grant := access.DirectGrant
		if access.EffectiveRole != test.role || grant == nil || grant.Role != test.role || grant.UserID != test.userID || grant.ProjectID != h.project.ID || grant.Version < 1 || grant.CreatedAt.IsZero() || grant.UpdatedAt.IsZero() || grant.CreatedAt.Location() != time.UTC || grant.UpdatedAt.Location() != time.UTC {
			t.Fatalf("actor access: %#v", access)
		}
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != test.userID {
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
		if test.role == "admin" && (grant.Version != 9007199254740993 || string(direct["version"]) != "9007199254740993") {
			t.Fatalf("grant version lost precision or number representation: %s", direct["version"])
		}
		snapshot := decodeResponse[api.TaskSync](t, h.call(http.MethodGet, syncPath(h.project.ID), "", test.cookie), http.StatusOK)
		deltaResponse := h.call(http.MethodGet, syncPath(h.project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", "", test.cookie)
		delta := decodeResponse[api.TaskSync](t, deltaResponse, http.StatusOK)
		if !reflect.DeepEqual(snapshot.ActorAccess, access) || !reflect.DeepEqual(delta.ActorAccess, access) || delta.Mode != "delta" || delta.Tasks == nil || len(delta.Tasks) != 0 || !strings.Contains(deltaResponse.Body.String(), `"actorAccess":`) {
			t.Fatalf("actor projection missing from empty sync: %#v %#v", snapshot, delta)
		}
	}
	unauthenticated := h.call(http.MethodGet, path, "", nil)
	assertProjectError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
	if unauthenticated.Header().Get("Daynight-User-ID") != "" {
		t.Fatal("unauthenticated response exposes an actor")
	}
	assertProjectError(t, h.call(http.MethodGet, path, "", h.outsider), http.StatusNotFound, "not_found")
	assertProjectError(t, h.call(http.MethodGet, "/api/v1/projects/invalid/access", "", h.admin), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, h.call(http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099/access", "", h.admin), http.StatusNotFound, "not_found")
	assertProjectError(t, h.call(http.MethodGet, path+"?unknown=secret", "", h.admin), http.StatusBadRequest, "invalid_input")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := h.call(method, path, "private-body-secret", h.admin)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.adminID {
			t.Fatalf("method boundary: %#v", response.Header())
		}
	}
	server := httptest.NewServer(h.handler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(h.admin)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || len(body) != 0 || response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != h.adminID {
		t.Fatalf("HEAD actor access: %#v %s %v", response, body, readErr)
	}
	if _, err := h.database.Pool.Exec(context.Background(), "DROP TABLE project_grants"); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.call(http.MethodGet, path, "", h.admin), http.StatusInternalServerError, "internal_error")
	if strings.Contains(h.logs.String(), "private-body-secret") || strings.Contains(h.logs.String(), "unknown=secret") {
		t.Fatal("access diagnostics exposed request contents")
	}
}

func TestOwnershipProjectionExactVersionsAcrossCurrentReaders(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	projectRoutes(mux, service.NewProjects(h.database), h.auth, logger)
	taskRoutes(mux, service.NewTasks(h.database), h.auth, logger)
	taskSyncRoutes(mux, service.NewTaskSync(h.database, time.Second), h.auth, logger, time.Second)
	NewMembershipRoutes(service.NewMemberships(h.database), h.auth, logger).RegisterRoutes(mux)
	h.handler = RequestLogging(logger, mux)
	ctx := context.Background()
	if _, err := h.database.Pool.Exec(ctx, `UPDATE project_ownership SET version=9007199254740993 WHERE project_id=$1`, h.project.ID); err != nil {
		t.Fatal(err)
	}
	me := decodeResponse[api.User](t, h.call("GET", "/api/v1/me", "", h.admin), 200)
	if me.PersonalTeam.ID != h.project.Ownership.TeamID || me.PersonalTeam.Kind != "personal" || me.PersonalTeam.Name != nil {
		t.Fatalf("Personal reference: %#v", me)
	}
	base := "/api/v1/projects/" + h.project.ID
	response := h.call("GET", base, "", h.admin)
	document := decodeResponse[api.ProjectDocument](t, response, 200)
	if document.Ownership.TeamID != me.PersonalTeam.ID || document.Ownership.Version != 9007199254740993 || document.Access.Ownership != document.Ownership || document.Access.OwnerTeam != me.PersonalTeam || document.Access.TeamRole == nil || *document.Access.TeamRole != "admin" || !document.Access.CanTransfer || !strings.Contains(response.Body.String(), `"version":9007199254740993`) {
		t.Fatalf("Project ownership/access: %s", response.Body)
	}
	page := decodeResponse[api.ProjectPage](t, h.call("GET", "/api/v1/projects", "", h.admin), 200)
	snapshot := decodeResponse[api.TaskSync](t, h.call("GET", base+"/task-sync", "", h.admin), 200)
	delta := decodeResponse[api.TaskSync](t, h.call("GET", base+"/task-sync?epoch="+snapshot.Epoch, "", h.admin), 200)
	people := decodeResponse[api.ProjectParticipantList](t, h.call("GET", base+"/members", "", h.admin), 200)
	if len(page.Items) != 1 || page.Items[0] != document.Project || snapshot.Project != document.Project || delta.Project != document.Project || !reflect.DeepEqual(snapshot.ActorAccess, document.Access) || !reflect.DeepEqual(people.ActorAccess, document.Access) || len(people.Items) != 1 || people.Items[0].InheritedFrom == nil || people.Items[0].InheritedFrom.Team != me.PersonalTeam || people.Items[0].InheritedFrom.Role != "admin" {
		t.Fatalf("current-reader divergence: %#v %#v %#v %#v", page, snapshot, delta, people)
	}
	created := decodeResponse[api.Task](t, h.call("POST", base+"/tasks", `{"title":"Ownership graph"}`, h.admin), 201)
	graph := decodeResponse[api.TaskGraph](t, h.call("GET", graphPath(h.project.ID, created.ID), "", h.admin), 200)
	if graph.Project != document.Project {
		t.Fatalf("graph ownership: %#v", graph.Project)
	}
	for _, intrinsic := range []any{page.Items[0], snapshot.Project, graph.Project} {
		data, err := json.Marshal(intrinsic)
		if err != nil || strings.Contains(string(data), `"access"`) || strings.Contains(string(data), `"effectiveRole"`) || strings.Contains(string(data), `"ownerTeam"`) {
			t.Fatalf("actor facts entered intrinsic Project: %s %v", data, err)
		}
	}
	if _, err := h.database.Pool.Exec(ctx, `DELETE FROM teams WHERE id=$1`, me.PersonalTeam.ID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.call("GET", "/api/v1/me", "", h.admin), 500, "internal_error")
}
