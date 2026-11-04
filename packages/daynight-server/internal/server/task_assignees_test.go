package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type assigneeHTTPEntry struct {
	UserID           string  `json:"userId"`
	Name             *string `json:"name"`
	AvatarURL        *string `json:"avatarUrl"`
	HasProjectAccess bool    `json:"hasProjectAccess"`
}

type assigneeHTTPResult struct {
	Items             []assigneeHTTPEntry `json:"items"`
	UnresolvedUserIDs []string            `json:"unresolvedUserIds"`
}

func taskAssigneesPath(projectID string) string {
	return "/api/v1/projects/" + projectID + "/task-assignees"
}

func assigneeHTTPIdentity(t *testing.T, database *store.Store, handler *resourceTestHandler, userID string) *resourceTestHandler {
	t.Helper()
	entropy := sha256.Sum256([]byte(userID + uuid.NewString()))
	token := "dnpat_" + base64.RawURLEncoding.EncodeToString(entropy[:])
	digest := sha256.Sum256([]byte(token))
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'assignee HTTP reader',now(),now()+interval '1 hour')`, uuid.NewString(), userID, digest[:]); err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: handler.Handler, token: token}
}

func assigneeHTTPQuery(ids ...string) string {
	query := url.Values{}
	for _, id := range ids {
		query.Add("userId", id)
	}
	return "?" + query.Encode()
}

func decodeAssigneeHTTPResult(t *testing.T, response *httptest.ResponseRecorder, principal string) assigneeHTTPResult {
	t.Helper()
	result := decodeResponse[assigneeHTTPResult](t, response, http.StatusOK)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != principal || response.Header().Get("X-Request-ID") != "project-test" {
		t.Fatalf("assignee resource lost admission or cache headers: %#v", response.Header())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 2 || fields["items"] == nil || fields["unresolvedUserIds"] == nil ||
		bytes.Equal(bytes.TrimSpace(fields["items"]), []byte("null")) || bytes.Equal(bytes.TrimSpace(fields["unresolvedUserIds"]), []byte("null")) || result.Items == nil || result.UnresolvedUserIDs == nil {
		t.Fatalf("invalid assignee envelope: %s, %v", response.Body, err)
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(fields["items"], &entries); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(entries))
	for index, entry := range entries {
		if len(entry) != 4 {
			t.Fatalf("assignee entry contains extra or missing fields: %s", fields["items"])
		}
		for _, key := range []string{"userId", "name", "avatarUrl", "hasProjectAccess"} {
			if _, ok := entry[key]; !ok {
				t.Fatalf("missing assignee entry field %q", key)
			}
		}
		access := bytes.TrimSpace(entry["hasProjectAccess"])
		if !bytes.Equal(access, []byte("true")) && !bytes.Equal(access, []byte("false")) {
			t.Fatalf("access flag is not an explicit boolean: %s", access)
		}
		id, err := uuid.Parse(result.Items[index].UserID)
		if err != nil || id.String() != result.Items[index].UserID {
			t.Fatalf("noncanonical assignee identity: %#v", result.Items[index])
		}
		ids = append(ids, result.Items[index].UserID)
	}
	if !slices.IsSorted(ids) || len(slices.Compact(slices.Clone(ids))) != len(ids) || !slices.IsSorted(result.UnresolvedUserIDs) {
		t.Fatalf("assignee result is not sorted and distinct: %#v", result)
	}
	return result
}

func assigneeHTTPEntries(t *testing.T, actual assigneeHTTPResult, expected map[string]bool, unresolved []string) map[string]assigneeHTTPEntry {
	t.Helper()
	if len(actual.Items) != len(expected) {
		t.Fatalf("assignee item count: got %#v want %v", actual, expected)
	}
	result := make(map[string]assigneeHTTPEntry, len(actual.Items))
	for _, item := range actual.Items {
		access, ok := expected[item.UserID]
		if !ok || item.HasProjectAccess != access {
			t.Fatalf("unexpected assignee qualification: %#v want %v", item, expected)
		}
		result[item.UserID] = item
	}
	want := append([]string{}, unresolved...)
	slices.Sort(want)
	if !slices.Equal(actual.UnresolvedUserIDs, want) {
		t.Fatalf("unresolved identities: got %v want %v", actual.UnresolvedUserIDs, want)
	}
	return result
}

func taskAssigneeHTTPFacts(t *testing.T, database *store.Store, projectID string) string {
	t.Helper()
	var facts string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t WHERE project_id=$1`, projectID).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestTaskAssigneesHTTPCatalogueAndBoundedResolution(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	emptyProfile := assignmentHTTPMember(t, database, project.ID)
	named := assignmentHTTPMember(t, database, project.ID)
	name, avatar := "Directory 中文", "https://images.example.test/assignee.png"
	if _, err := database.Pool.Exec(context.Background(), `UPDATE users SET name=$2,avatar_url=$3,email='directory-private-email@example.test' WHERE id=$1`, named, name, avatar); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{handler.principal.UserID: true, emptyProfile: true, named: true}
	var retained []string
	for _, state := range []string{"todo", "in_progress", "done"} {
		id := assignmentHTTPMember(t, database, project.ID)
		task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Retained " + state, "assignedTo": id})), http.StatusCreated)
		if state != "todo" {
			setHTTPTask(t, handler, task, state)
		}
		if state == "todo" {
			decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Repeated reference", "assignedTo": id})), http.StatusCreated)
		}
		if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, id); err != nil {
			t.Fatal(err)
		}
		expected[id] = false
		retained = append(retained, id)
	}
	deletedOnly := assignmentHTTPMember(t, database, project.ID)
	deletedTask := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Deleted reference", "assignedTo": deletedOnly})), http.StatusCreated)
	if response := projectRequest(handler, http.MethodDelete, taskPath(deletedTask), jsonBody(t, api.TaskDeleteRequest{Version: deletedTask.Version})); response.Code != http.StatusNoContent {
		t.Fatalf("delete fixture: %d %s", response.Code, response.Body)
	}
	if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, deletedOnly); err != nil {
		t.Fatal(err)
	}
	unrelated := assignmentHTTPUser(t, database)
	missing := uuid.NewString()
	otherProject := taskProject(t, handler)
	otherOnly := assignmentHTTPMember(t, database, otherProject.ID)
	decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(otherProject.ID), jsonBody(t, map[string]any{"title": "Foreign project reference", "assignedTo": otherOnly})), http.StatusCreated)
	before := taskAssigneeHTTPFacts(t, database, project.ID)
	path := taskAssigneesPath(project.ID)
	catalogueResponse := projectRequest(handler, http.MethodGet, path, "")
	catalogue := decodeAssigneeHTTPResult(t, catalogueResponse, handler.principal.UserID)
	entries := assigneeHTTPEntries(t, catalogue, expected, nil)
	if entries[emptyProfile].Name != nil || entries[emptyProfile].AvatarURL != nil || entries[named].Name == nil || *entries[named].Name != name || entries[named].AvatarURL == nil || *entries[named].AvatarURL != avatar {
		t.Fatalf("nullable/current profile data changed: %#v", entries)
	}
	requested := []string{otherOnly, retained[2], missing, strings.ToUpper(emptyProfile), unrelated, retained[0], deletedOnly, retained[1]}
	resolved := decodeAssigneeHTTPResult(t, projectRequest(handler, http.MethodGet, path+assigneeHTTPQuery(requested...), ""), handler.principal.UserID)
	assigneeHTTPEntries(t, resolved, map[string]bool{emptyProfile: true, retained[0]: false, retained[1]: false, retained[2]: false}, []string{deletedOnly, unrelated, missing, otherOnly})
	one := decodeAssigneeHTTPResult(t, projectRequest(handler, http.MethodGet, path+assigneeHTTPQuery(named), ""), handler.principal.UserID)
	assigneeHTTPEntries(t, one, map[string]bool{named: true}, nil)
	unresolvedOnly := decodeAssigneeHTTPResult(t, projectRequest(handler, http.MethodGet, path+assigneeHTTPQuery(unrelated, missing), ""), handler.principal.UserID)
	assigneeHTTPEntries(t, unresolvedOnly, map[string]bool{}, []string{unrelated, missing})
	member := assigneeHTTPIdentity(t, database, handler, emptyProfile)
	memberResult := decodeAssigneeHTTPResult(t, projectRequest(member, http.MethodGet, path, ""), emptyProfile)
	assigneeHTTPEntries(t, memberResult, expected, nil)
	if taskAssigneeHTTPFacts(t, database, project.ID) != before {
		t.Fatal("people reads changed task data or versions")
	}
	for _, private := range []string{"directory-private-email", "assignment-" + named, unrelated, otherOnly} {
		if strings.Contains(catalogueResponse.Body.String(), private) || strings.Contains(logs.String(), private) {
			t.Fatalf("assignee catalogue or logs leaked private input %q", private)
		}
	}
}

func TestTaskAssigneesHTTPStrictQueryAndHundredIDBoundary(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	path := taskAssigneesPath(project.ID)
	for _, query := range []string{
		"?userId=", "?userId=me", "?userId=unassigned", "?userId=invalid", "?userId=%xx", "?userId=%ff", "?userId=%00", "?%xx=x", "?unknown=x", "?UserId=" + handler.principal.UserID, "?userId=" + handler.principal.UserID + "&userId=" + handler.principal.UserID,
		"?userId=" + handler.principal.UserID + "&userId=" + strings.ToUpper(handler.principal.UserID), "?userId=%20" + handler.principal.UserID, "?;", "?=x",
	} {
		response := projectRequest(handler, http.MethodGet, path+query, "")
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
			t.Fatal("invalid assignee query lost request admission headers")
		}
	}
	ids := []string{handler.principal.UserID}
	for len(ids) < 100 {
		ids = append(ids, uuid.NewString())
	}
	response := projectRequest(handler, http.MethodGet, path+assigneeHTTPQuery(ids...), "")
	result := decodeAssigneeHTTPResult(t, response, handler.principal.UserID)
	assigneeHTTPEntries(t, result, map[string]bool{handler.principal.UserID: true}, ids[1:])
	ids = append(ids, uuid.NewString())
	assertProjectError(t, projectRequest(handler, http.MethodGet, path+assigneeHTTPQuery(ids...), ""), http.StatusBadRequest, "invalid_input")
}

func TestTaskAssigneesHTTPAdmissionMethodsAndRemovedReader(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	path := taskAssigneesPath(project.ID)
	readerID := assignmentHTTPMember(t, database, project.ID)
	reader := assigneeHTTPIdentity(t, database, handler, readerID)
	task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Assignment gives no read permission", "assignedTo": readerID})), http.StatusCreated)
	decodeAssigneeHTTPResult(t, projectRequest(reader, http.MethodGet, path, ""), readerID)
	anonymous := projectRequest(handler.Handler, http.MethodGet, path, "")
	assertProjectError(t, anonymous, http.StatusUnauthorized, "unauthenticated")
	if anonymous.Header().Get("Daynight-User-ID") != "" {
		t.Fatal("unauthenticated assignee response disclosed identity")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskAssigneesPath(uuid.NewString()), ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskAssigneesPath("invalid"), ""), http.StatusBadRequest, "invalid_input")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, path, "private request body")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("assignee methods: %#v", response.Header())
		}
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+path+assigneeHTTPQuery(readerID), nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || len(body) != 0 || response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != handler.principal.UserID || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("HEAD assignees: %#v %s %v", response, body, readErr)
	}
	if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, readerID); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", assigneeHTTPQuery(readerID)} {
		assertProjectError(t, projectRequest(reader, http.MethodGet, path+suffix, ""), http.StatusNotFound, "not_found")
	}
	if stored := readHTTPTask(t, handler, task); stored.AssignedTo == nil || *stored.AssignedTo != readerID {
		t.Fatal("removing reader cleared retained assignment")
	}
}

func TestTaskAssigneesHTTPMissingQualifiedUsersFailWithoutPartialData(t *testing.T) {
	for _, retained := range []bool{false, true} {
		t.Run(map[bool]string{false: "member", true: "retained assignee"}[retained], func(t *testing.T) {
			database := projectTestStore(t)
			var logs bytes.Buffer
			handler := projectTestHandler(t, database, &logs)
			project := taskProject(t, handler)
			missing := assignmentHTTPMember(t, database, project.ID)
			if retained {
				decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Missing retained user", "assignedTo": missing})), http.StatusCreated)
				if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, missing); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := database.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, missing); err != nil {
				t.Fatal(err)
			}
			for _, suffix := range []string{"", assigneeHTTPQuery(handler.principal.UserID, missing)} {
				response := projectRequest(handler, http.MethodGet, taskAssigneesPath(project.ID)+suffix, "")
				assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
					t.Fatal(err)
				}
				if _, ok := fields["items"]; ok {
					t.Fatal("qualified user corruption returned partial people")
				}
				if _, ok := fields["unresolvedUserIds"]; ok {
					t.Fatal("qualified user corruption became unresolved")
				}
			}
			if strings.Contains(logs.String(), missing) {
				t.Fatal("integrity failure logs leaked the requested identity")
			}
		})
	}
}
