package server

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskSyncHTTPAssigneeManifestContainsOnlyVersionsAndAccess(t *testing.T) {
	f := newTaskHTTPFixture(t)
	member := "c6666666-6666-4666-8666-666666666666"
	name := "Private profile name"
	avatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	versions := []model.TaskAssigneeVersion{
		{UserID: f.principal.UserID, Version: taskHTTPAdminProfileVersion, HasProjectAccess: true},
		{UserID: member, Version: "1d34e2f377c506a34cfea8eca119d58ece7a39c19e447ccb3232f48cd3ea7f85", HasProjectAccess: true},
	}
	f.expectSync([]model.TaskViewRecord{}, versions, nil)
	response := projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), "")
	snapshot := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	if snapshot.AssigneeVersions == nil || len(snapshot.AssigneeVersions) != 2 || snapshot.Tasks == nil || len(snapshot.Tasks) != 0 {
		t.Fatalf("manifest excluded members without Tasks: %#v", snapshot)
	}
	if strings.Contains(response.Body.String(), avatar) || strings.Contains(response.Body.String(), name) {
		t.Fatal("TaskSync transferred profile content")
	}
	var wire struct {
		AssigneeVersions []map[string]json.RawMessage `json:"assigneeVersions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	calls := projectHTTPCount(t, 1)
	declared := model.TaskAssignees{Items: []model.TaskAssignee{
		{UserID: f.principal.UserID, Version: taskHTTPAdminProfileVersion, HasProjectAccess: true},
		{UserID: member, Version: "1d34e2f377c506a34cfea8eca119d58ece7a39c19e447ccb3232f48cd3ea7f85", Name: copyTaskHTTPPointer(&name), AvatarURL: copyTaskHTTPPointer(&avatar), HasProjectAccess: true},
	}, UnresolvedUserIDs: []string{}}
	f.tasks.AssigneesCall = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
		calls()
		f.requireOperation(ctx, principal, projectID)
		projectHTTPCheck(t, input, taskservice.TaskAssigneesRequest{})
		result := declared
		result.Items = copyTaskHTTPSlice(declared.Items)
		for i := range result.Items {
			result.Items[i].Name = copyTaskHTTPPointer(result.Items[i].Name)
			result.Items[i].AvatarURL = copyTaskHTTPPointer(result.Items[i].AvatarURL)
		}
		result.UnresolvedUserIDs = copyTaskHTTPSlice(declared.UnresolvedUserIDs)
		return result, nil
	}

	people := decodeAssigneeHTTPResult(t, projectRequest(f.handler, http.MethodGet, taskAssigneesPath(f.project.ID), ""), f.principal.UserID)
	for index, entry := range wire.AssigneeVersions {
		if len(entry) != 3 || entry["userId"] == nil || entry["version"] == nil || entry["hasProjectAccess"] == nil {
			t.Fatalf("manifest fields: %#v", entry)
		}
		person := people.Items[index]
		if snapshot.AssigneeVersions[index] != (api.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess}) {
			t.Fatalf("manifest/current people differ: %#v %#v", snapshot.AssigneeVersions[index], person)
		}
	}
	since := time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)
	lower := since.Add(-10 * time.Second)
	f.expectSync([]model.TaskViewRecord{}, versions, &lower)
	delta := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", ""), http.StatusOK)
	if delta.Mode != "delta" || len(delta.Tasks) != 0 || !reflect.DeepEqual(delta.AssigneeVersions, snapshot.AssigneeVersions) {
		t.Fatalf("empty delta manifest: %#v", delta)
	}
}
