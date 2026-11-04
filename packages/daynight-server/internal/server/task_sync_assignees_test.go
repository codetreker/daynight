package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskSyncHTTPAssigneeManifestContainsOnlyVersionsAndAccess(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	member := assignmentHTTPMember(t, database, project.ID)
	avatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE users SET name='Private profile name',avatar_url=$2 WHERE id=$1`, member, avatar); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, syncPath(project.ID), "")
	snapshot := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	if snapshot.AssigneeVersions == nil || len(snapshot.AssigneeVersions) != 2 || snapshot.Tasks == nil || len(snapshot.Tasks) != 0 {
		t.Fatalf("manifest excluded members without tasks: %#v", snapshot)
	}
	if strings.Contains(response.Body.String(), avatar) || strings.Contains(response.Body.String(), "Private profile name") {
		t.Fatal("task-sync transferred profile content instead of the lightweight manifest")
	}
	var wire struct {
		AssigneeVersions []map[string]json.RawMessage `json:"assigneeVersions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	people := decodeAssigneeHTTPResult(t, projectRequest(handler, http.MethodGet, taskAssigneesPath(project.ID), ""), handler.principal.UserID)
	for index, entry := range wire.AssigneeVersions {
		if len(entry) != 3 || entry["userId"] == nil || entry["version"] == nil || entry["hasProjectAccess"] == nil {
			t.Fatalf("invalid manifest entry: %#v", entry)
		}
		person := people.Items[index]
		if snapshot.AssigneeVersions[index] != (api.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess}) {
			t.Fatalf("manifest and current people content disagree: %#v %#v", snapshot.AssigneeVersions[index], person)
		}
	}
	delta := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", ""), http.StatusOK)
	if delta.Mode != "delta" || len(delta.Tasks) != 0 || !reflect.DeepEqual(delta.AssigneeVersions, snapshot.AssigneeVersions) {
		t.Fatalf("empty delta omitted or changed the people manifest: %#v", delta)
	}
}
