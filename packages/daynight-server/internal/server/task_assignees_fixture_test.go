package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"

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
