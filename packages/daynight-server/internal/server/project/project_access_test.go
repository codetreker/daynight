package project

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectAccessHTTPProjectionAuthorizationAndMethods(t *testing.T) {
	admin := defaultHTTPPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	outsider := model.Principal{UserID: "f6666666-6666-4666-8666-666666666666", CredentialID: "a7777777-7777-4777-8777-777777777777", Kind: model.PATCredential}
	project := projectHTTPRecord("a8888888-8888-4888-8888-888888888888", "Access projection", "https://example.test/access.git", "b9999999-9999-4999-8999-999999999999")
	var logs bytes.Buffer
	adminTx := newHTTPTestStoreForPrincipal(t, admin)
	adminHandler := resourceTestServerForPrincipal(t, adminTx, &logs, admin)
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
			handler = resourceTestServerForPrincipal(t, tx, &logs, test.principal)
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

	}
	unauthenticated := projectRequest(adminHandler.Handler, http.MethodGet, path, "")
	assertProjectError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
	if unauthenticated.Header().Get("Daynight-User-ID") != "" {
		t.Fatal("unauthenticated response exposes an actor")
	}
	outsiderTx := newHTTPTestStoreForPrincipal(t, outsider)
	outsiderHandler := resourceTestServerForPrincipal(t, outsiderTx, &logs, outsider)
	accessHTTPRefusal(t, outsiderTx, outsider, project.ID, model.ErrNotFound)
	assertProjectError(t, projectRequest(outsiderHandler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(adminHandler, http.MethodGet, "/api/v1/projects/invalid/access", ""), http.StatusBadRequest, "invalid_input")
	const missing = "00000000-0000-4000-8000-000000000099"
	accessHTTPRefusal(t, adminTx, admin, missing, model.ErrNotFound)
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
	accessHTTPProject(t, adminTx, admin, project, expected, "access", nil, nil)
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
