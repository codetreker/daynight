package task_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

type assigneeHTTPEntry struct {
	UserID           string  `json:"userId"`
	Version          string  `json:"version"`
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
		if len(entry) != 5 {
			t.Fatalf("assignee entry contains extra or missing fields: %s", fields["items"])
		}
		for _, key := range []string{"userId", "version", "name", "avatarUrl", "hasProjectAccess"} {
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
		version := result.Items[index].Version
		if decoded, err := hex.DecodeString(version); err != nil || len(decoded) != sha256.Size || version != strings.ToLower(version) {
			t.Fatalf("invalid assignee content version: %q", version)
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

func assigneeFact(id string, access bool, name, avatar *string) model.TaskAssignee {
	return model.TaskAssignee{UserID: id, Version: strings.Repeat("a", 64), Name: name, AvatarURL: avatar, HasProjectAccess: access}
}

func assigneeResult(items []model.TaskAssignee, unresolved []string) model.TaskAssignees {
	items = slices.Clone(items)
	slices.SortFunc(items, func(a, b model.TaskAssignee) int { return strings.Compare(a.UserID, b.UserID) })
	unresolved = slices.Clone(unresolved)
	slices.Sort(unresolved)
	return model.TaskAssignees{Items: items, UnresolvedUserIDs: unresolved}
}

func requireAssigneeCall(t *testing.T, ctx context.Context, principal model.Principal, projectID string, expected model.Principal, input, expectedInput taskservice.TaskAssigneesRequest) {
	t.Helper()
	if ctx.Err() != nil || httpx.RequestID(ctx) != "project-test" || principal != expected || projectID != testProjectID || !reflect.DeepEqual(input, expectedInput) {
		t.Fatalf("assignee request changed: principal=%#v project=%s input=%#v expected=%#v", principal, projectID, input, expectedInput)
	}
}

func TestTaskAssigneesHTTPCatalogueAndBoundedResolution(t *testing.T) {
	emptyProfile := "a5555555-a555-4555-8555-a55555555555"
	named := "b6666666-b666-4666-8666-b66666666666"
	retained := []string{"d7777777-d777-4777-8777-d77777777777", "e8888888-e888-4888-8888-e88888888888", "f9999999-f999-4999-8999-f99999999999"}
	deletedOnly, unrelated, missing, otherOnly := "11111111-1111-4111-8111-111111111110", "11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111112", "11111111-1111-4111-8111-111111111113"
	name, avatar := "Directory 中文", "https://images.example.test/assignee.png"
	catalogue := []model.TaskAssignee{assigneeFact(testUserID, true, nil, nil), assigneeFact(emptyProfile, true, nil, nil), assigneeFact(named, true, &name, &avatar)}
	for _, id := range retained {
		catalogue = append(catalogue, assigneeFact(id, false, nil, nil))
	}
	expected := map[string]bool{testUserID: true, emptyProfile: true, named: true, retained[0]: false, retained[1]: false, retained[2]: false}
	requested := []string{otherOnly, retained[2], missing, strings.ToUpper(emptyProfile), unrelated, retained[0], deletedOnly, retained[1]}
	cases := []struct {
		name   string
		input  taskservice.TaskAssigneesRequest
		result model.TaskAssignees
		access map[string]bool
		actor  string
	}{
		{"catalogue", taskservice.TaskAssigneesRequest{}, assigneeResult(catalogue, nil), expected, testUserID},
		{"resolution", taskservice.TaskAssigneesRequest{UserIDs: requested}, assigneeResult([]model.TaskAssignee{assigneeFact(emptyProfile, true, nil, nil), assigneeFact(retained[0], false, nil, nil), assigneeFact(retained[1], false, nil, nil), assigneeFact(retained[2], false, nil, nil)}, []string{deletedOnly, unrelated, missing, otherOnly}), map[string]bool{emptyProfile: true, retained[0]: false, retained[1]: false, retained[2]: false}, testUserID},
		{"one", taskservice.TaskAssigneesRequest{UserIDs: []string{named}}, assigneeResult([]model.TaskAssignee{assigneeFact(named, true, &name, &avatar)}, nil), map[string]bool{named: true}, testUserID},
		{"unresolved only", taskservice.TaskAssigneesRequest{UserIDs: []string{unrelated, missing}}, assigneeResult(nil, []string{unrelated, missing}), map[string]bool{}, testUserID},
		{"member catalogue", taskservice.TaskAssigneesRequest{}, assigneeResult(catalogue, nil), expected, emptyProfile},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			h.principal.UserID = tc.actor
			h.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
				requireAssigneeCall(t, ctx, p, projectID, h.principal, input, tc.input)
				return tc.result, nil
			}
			path := taskAssigneesPath(testProjectID)
			if tc.input.UserIDs != nil {
				path += assigneeHTTPQuery(tc.input.UserIDs...)
			}
			response := projectRequest(h, http.MethodGet, path, "")
			actual := decodeAssigneeHTTPResult(t, response, h.principal.UserID)
			entries := assigneeHTTPEntries(t, actual, tc.access, tc.result.UnresolvedUserIDs)
			if entry, ok := entries[emptyProfile]; ok && (entry.Name != nil || entry.AvatarURL != nil) {
				t.Fatal("nullable profile fields became defaults")
			}
			if entry, ok := entries[named]; ok && (entry.Name == nil || *entry.Name != name || entry.AvatarURL == nil || *entry.AvatarURL != avatar) {
				t.Fatal("public profile fields changed")
			}
			for _, private := range []string{"directory-private-email", "assignment-" + named, unrelated, otherOnly} {
				if strings.Contains(logs.String(), private) || tc.input.UserIDs == nil && strings.Contains(response.Body.String(), private) {
					t.Fatalf("assignee resource or logs leaked %q: %s %s", private, response.Body, &logs)
				}
			}
		})
	}
}

func TestTaskAssigneesHTTPStrictQueryAndHundredIDBoundary(t *testing.T) {
	for _, tc := range []struct {
		query string
		raw   []string
	}{
		{"?userId=", nil}, {"?userId=me", []string{"me"}}, {"?userId=unassigned", []string{"unassigned"}}, {"?userId=invalid", []string{"invalid"}},
		{"?userId=%xx", nil}, {"?userId=%ff", []string{"\xff"}}, {"?userId=%00", []string{"\x00"}}, {"?%xx=x", nil}, {"?unknown=x", nil}, {"?UserId=" + testUserID, nil},
		{"?userId=" + testUserID + "&userId=" + testUserID, []string{testUserID, testUserID}},
		{"?userId=" + testUserID + "&userId=" + strings.ToUpper(testUserID), []string{testUserID, strings.ToUpper(testUserID)}},
		{"?userId=%20" + testUserID, []string{" " + testUserID}}, {"?;", nil}, {"?=x", nil},
	} {
		t.Run(tc.query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			if tc.raw != nil {
				h.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
					requireAssigneeCall(t, ctx, p, projectID, h.principal, input, taskservice.TaskAssigneesRequest{UserIDs: tc.raw})
					return model.TaskAssignees{}, &model.Fault{Code: "invalid_input", Message: "Invalid assignee identities."}
				}
			}
			response := projectRequest(h, http.MethodGet, taskAssigneesPath(testProjectID)+tc.query, "")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID {
				t.Fatal("invalid query lost admission/cache headers")
			}
			if tc.raw == nil && h.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid HTTP query reached service")
			}
		})
	}
	ids := []string{testUserID}
	for len(ids) < 100 {
		ids = append(ids, uuid.NewString())
	}
	h := newHTTPFixture(t, io.Discard)
	result := assigneeResult([]model.TaskAssignee{assigneeFact(testUserID, true, nil, nil)}, ids[1:])
	h.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
		requireAssigneeCall(t, ctx, p, projectID, h.principal, input, taskservice.TaskAssigneesRequest{UserIDs: ids[:100]})
		return result, nil
	}
	actual := decodeAssigneeHTTPResult(t, projectRequest(h, http.MethodGet, taskAssigneesPath(testProjectID)+assigneeHTTPQuery(ids...), ""), testUserID)
	assigneeHTTPEntries(t, actual, map[string]bool{testUserID: true}, ids[1:])
	ids = append(ids, uuid.NewString())
	assertProjectError(t, projectRequest(h, http.MethodGet, taskAssigneesPath(testProjectID)+assigneeHTTPQuery(ids...), ""), http.StatusBadRequest, "invalid_input")
	if h.Tasks.Calls("Assignees") != 1 {
		t.Fatal("101-ID boundary reached service")
	}
}

func TestTaskAssigneesHTTPAdmissionMethodsAndRemovedReader(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	path := taskAssigneesPath(testProjectID)
	readerID := "a5555555-a555-4555-8555-a55555555555"
	h.Tasks.ExpectCalls("Assignees", 2)
	calls := 0
	h.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
		calls++
		want := taskservice.TaskAssigneesRequest{}
		if calls == 2 {
			want.UserIDs = []string{readerID}
		}
		requireAssigneeCall(t, ctx, p, projectID, h.principal, input, want)
		return assigneeResult([]model.TaskAssignee{assigneeFact(readerID, true, nil, nil)}, nil), nil
	}
	decodeAssigneeHTTPResult(t, projectRequest(h, http.MethodGet, path, ""), testUserID)
	anonymous := projectRequest(h.Handler, http.MethodGet, path, "")
	assertProjectError(t, anonymous, http.StatusUnauthorized, "unauthenticated")
	if anonymous.Header().Get("Daynight-User-ID") != "" {
		t.Fatal("anonymous response disclosed identity")
	}
	assertProjectError(t, projectRequest(h, http.MethodGet, taskAssigneesPath("invalid"), ""), http.StatusBadRequest, "invalid_input")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(h, method, path, "private request body")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("assignee method headers: %#v", response.Header())
		}
	}
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	request, err := http.NewRequest(http.MethodHead, server.URL+path+assigneeHTTPQuery(readerID), nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(h, request)
	request.Header.Set("X-Request-ID", "project-test")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || len(body) != 0 || response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != testUserID || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("HEAD assignees: %#v %s %v", response, body, readErr)
	}
	for _, suffix := range []string{"", assigneeHTTPQuery(readerID)} {
		t.Run("removed reader"+suffix, func(t *testing.T) {
			removed := newHTTPFixture(t, io.Discard)
			removed.principal.UserID = readerID
			want := taskservice.TaskAssigneesRequest{}
			if suffix != "" {
				want.UserIDs = []string{readerID}
			}
			removed.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
				requireAssigneeCall(t, ctx, p, projectID, removed.principal, input, want)
				return model.TaskAssignees{}, &model.Fault{Code: "not_found", Message: "Project not found."}
			}
			assertProjectError(t, projectRequest(removed, http.MethodGet, path+suffix, ""), http.StatusNotFound, "not_found")
		})
	}
	missing := newHTTPFixture(t, io.Discard)
	missing.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
		if p != missing.principal || projectID != testEpoch || input.UserIDs != nil {
			t.Fatal("missing project identity changed")
		}
		return model.TaskAssignees{}, &model.Fault{Code: "not_found", Message: "Project not found."}
	}
	assertProjectError(t, projectRequest(missing, http.MethodGet, taskAssigneesPath(testEpoch), ""), http.StatusNotFound, "not_found")
}

func TestTaskAssigneesHTTPMissingQualifiedUsersFailWithoutPartialData(t *testing.T) {
	missing := "a5555555-a555-4555-8555-a55555555555"
	for _, name := range []string{"member", "retained assignee"} {
		for _, suffix := range []string{"", assigneeHTTPQuery(testUserID, missing)} {
			t.Run(name+suffix, func(t *testing.T) {
				var logs bytes.Buffer
				h := newHTTPFixture(t, &logs)
				input := taskservice.TaskAssigneesRequest{}
				if suffix != "" {
					input.UserIDs = []string{testUserID, missing}
				}
				h.Tasks.AssigneesFunc = func(ctx context.Context, p model.Principal, projectID string, actual taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
					requireAssigneeCall(t, ctx, p, projectID, h.principal, actual, input)
					return model.TaskAssignees{}, errors.New("qualified user " + missing + " is missing")
				}
				response := projectRequest(h, http.MethodGet, taskAssigneesPath(testProjectID)+suffix, "")
				assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
					t.Fatal(err)
				}
				if _, ok := fields["items"]; ok {
					t.Fatal("integrity failure returned partial people")
				}
				if _, ok := fields["unresolvedUserIds"]; ok {
					t.Fatal("integrity failure became unresolved")
				}
				if strings.Contains(logs.String(), missing) || strings.Contains(response.Body.String(), missing) {
					t.Fatal("integrity failure disclosed requested identity")
				}
			})
		}
	}
}
