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
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE project_members SET version=9007199254740993 WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.adminID); err != nil {
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
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 2 || fields["effectiveRole"] == nil || fields["directGrant"] == nil {
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
	if _, err := h.database.Pool.Exec(context.Background(), "DROP TABLE project_members"); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.call(http.MethodGet, path, "", h.admin), http.StatusInternalServerError, "internal_error")
	if strings.Contains(h.logs.String(), "private-body-secret") || strings.Contains(h.logs.String(), "unknown=secret") {
		t.Fatal("access diagnostics exposed request contents")
	}
}
