package task_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
)

func TestTaskSyncSessionWireContainsOnlyTaskKeysAndFourStates(t *testing.T) {
	sessions := map[string]model.SessionListState{
		"11111111-1111-4111-8111-111111111111": model.SessionListWorking,
		"22222222-2222-4222-8222-222222222222": model.SessionListNotice,
		"33333333-3333-4333-8333-333333333333": model.SessionListWarning,
		"44444444-4444-4444-8444-444444444444": model.SessionListPending,
	}
	response := taskhttp.TaskSyncResponse(model.TaskSync{Sessions: sessions})
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	var states map[string]string
	if err := json.Unmarshal(fields["sessions"], &states); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"11111111-1111-4111-8111-111111111111": "working",
		"22222222-2222-4222-8222-222222222222": "notice",
		"33333333-3333-4333-8333-333333333333": "warning",
		"44444444-4444-4444-8444-444444444444": "pending",
	}
	if !reflect.DeepEqual(states, want) {
		t.Fatalf("session wire: %s", fields["sessions"])
	}
	if len(fields) != 8 {
		t.Fatalf("unexpected envelope fields: %v", fields)
	}
	delete(response.Sessions, "11111111-1111-4111-8111-111111111111")
	if sessions["11111111-1111-4111-8111-111111111111"] != model.SessionListWorking {
		t.Fatal("DTO map aliases service result")
	}
}

func TestTaskSyncSessionWirePreservesEmptyCollection(t *testing.T) {
	response := taskhttp.TaskSyncResponse(model.TaskSync{Sessions: map[string]model.SessionListState{}})
	if response.Sessions == nil {
		t.Fatal("valid empty collection became nil")
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["sessions"]) != "{}" {
		t.Fatalf("empty collection: %s", fields["sessions"])
	}
	if result := taskhttp.TaskSyncResponse(model.TaskSync{}); result.Sessions != nil {
		t.Fatal("converter manufactured missing producer collection")
	}
}
