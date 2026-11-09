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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskSyncHTTPAssigneeManifestContainsOnlyVersionsAndAccess(t *testing.T) {
	f := newTaskHTTPFixture(t)
	member := "c6666666-6666-4666-8666-666666666666"
	name := "Private profile name"
	avatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	facts := []model.TaskAssigneeFact{
		{UserID: f.principal.UserID, ProfileID: &f.principal.UserID, HasProjectAccess: true, Qualified: true},
		{UserID: member, ProfileID: &member, Name: &name, AvatarURL: &avatar, HasProjectAccess: true, Qualified: true},
	}
	f.expectSync([]model.TaskViewRecord{}, facts, nil, store.TaskGraphSize{})
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
	f.expectSnapshot(map[string]int{"people": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, p *httpCallPlan) {
		declared := copyTaskHTTPAssigneeFacts(facts)
		reader.TaskAssigneesFn = func(ctx context.Context, project string) ([]model.TaskAssigneeFact, error) {
			f.require(ctx, project)
			p.Called("people")
			return copyTaskHTTPAssigneeFacts(declared), nil
		}
	})
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
	f.expectSync([]model.TaskViewRecord{}, facts, &lower, store.TaskGraphSize{})
	delta := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", ""), http.StatusOK)
	if delta.Mode != "delta" || len(delta.Tasks) != 0 || !reflect.DeepEqual(delta.AssigneeVersions, snapshot.AssigneeVersions) {
		t.Fatalf("empty delta manifest: %#v", delta)
	}
}
