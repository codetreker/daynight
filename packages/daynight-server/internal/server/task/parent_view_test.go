package task

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
)

func TestTaskParentViewHeaderValidation(t *testing.T) {
	for _, values := range [][]string{nil, {"task-parent-v1"}, {""}, {"v2"}, {"task-parent-v1", "task-parent-v1"}} {
		r := httptest.NewRequest("GET", "/", nil)
		for _, v := range values {
			r.Header.Add(taskRelationsHeader, v)
		}
		want := len(values) == 0 || (len(values) == 1 && values[0] == "task-parent-v1")
		if (validateTaskParentView(r) == nil) != want {
			t.Fatalf("header %q", values)
		}
	}
}

func TestTaskParentFilterHTTPParsing(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	r := httptest.NewRequest("GET", "/?parentTaskId="+id, nil)
	list, err := taskListRequest(r)
	if err != nil || list.ParentTask == nil || *list.ParentTask != id {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	search, err := searchInput(map[string]json.RawMessage{"query": json.RawMessage(`"cache"`), "parentTaskId": json.RawMessage(`"` + id + `"`)})
	if err != nil || search.ParentTask == nil || *search.ParentTask != id {
		t.Fatalf("search=%+v err=%v", search, err)
	}
	if _, err := searchInput(map[string]json.RawMessage{"query": json.RawMessage(`"cache"`), "parentTaskId": json.RawMessage(`null`)}); err == nil {
		t.Fatal("null Task parent accepted")
	}
}

func TestParentProjectionGraphSyncAndSearch(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, enabled := range []bool{false, true} {
		graph := TaskGraphResponse(model.TaskGraph{Tasks: []model.GraphTask{{ParentID: &id, ParentType: model.TaskTypeTask}}}, enabled)
		sync := TaskSyncResponse(model.TaskSync{Tasks: []model.TaskViewRecord{{ParentID: &id, ParentType: model.TaskTypeTask}}}, enabled)
		search := searchResponse(tasksearch.Page{Items: []tasksearch.Item{{ParentID: &id, ParentType: model.TaskTypeTask, Context: &tasksearch.Context{TaskID: id, Title: "Actual parent"}}}}, enabled)
		for _, value := range []any{graph.Tasks[0], sync.Tasks[0], search.Items[0]} {
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if string(fields["parentId"]) != "null" {
				t.Fatalf("ordinary parent leaked into Goal ID: %s", data)
			}
			parent, present := fields["parentTaskId"]
			if present != enabled || (enabled && string(parent) != `"`+id+`"`) {
				t.Fatalf("extension: %s", data)
			}
		}
		if search.Items[0].Context != nil || (search.Items[0].ParentTaskContext != nil) != enabled {
			t.Fatalf("search contexts: %+v", search.Items[0])
		}
	}
}
