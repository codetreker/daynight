package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskSyncObservationHTTPEncoding(t *testing.T) {
	handler := newHTTPFixture(t, io.Discard)
	result := syncModel()
	observed := time.Date(2026, 11, 14, 12, 0, 0, 123, time.UTC)
	fresh := observed.Add(30 * time.Second)
	attention := false
	result.ObservedAt = observed.Add(-time.Hour)
	result.ResponseTaskAt = observed.Add(25 * time.Second)
	result.ResponseSessionAt = observed.Add(3 * time.Minute)
	result.SessionPartial = true
	result.TaskObservations = map[string]model.TaskSyncObservation{}
	states := []string{"no_session", "not_registered", "pending", "working", "notice", "warning", "unavailable", "unavailable"}
	for i, state := range states {
		id := "0000000" + strconv.Itoa(i+1) + "-0000-4000-8000-000000000000"
		result.TaskObservations[id] = model.TaskSyncObservation{TaskVersion: 9223372036854775807, State: state, ObservedAt: &observed, FreshUntil: &fresh, NeedsAttention: &attention, CanOpen: i >= 2}
	}
	unavailableID := "00000008-0000-4000-8000-000000000000"
	result.TaskObservations[unavailableID] = model.TaskSyncObservation{TaskVersion: 9223372036854775807, State: "unavailable"}
	handler.ExpectCalls("Sync", 1)
	handler.Sync = func(ctx context.Context, principal model.Principal, projectID string, request taskservice.TaskSyncRequest) (model.TaskSync, error) {
		if principal != handler.principal || projectID != testProjectID || ctx.Err() != nil {
			t.Fatalf("unexpected authenticated resource: %#v %q", principal, projectID)
		}
		return result, nil
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var body struct {
		Observations map[string]map[string]json.RawMessage `json:"taskObservations"`
		Partial      *bool                                 `json:"sessionPartial"`
		ObservedAt   time.Time                             `json:"observedAt"`
		TaskAt       time.Time                             `json:"responseTaskAt"`
		SessionAt    time.Time                             `json:"responseSessionAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Partial == nil || !*body.Partial || !body.ObservedAt.Equal(result.ObservedAt) || !body.TaskAt.Equal(result.ResponseTaskAt) || !body.SessionAt.Equal(result.ResponseSessionAt) || len(body.Observations) != len(states) {
		t.Fatalf("observation envelope: %+v", body)
	}
	for i, state := range states {
		id := "0000000" + strconv.Itoa(i+1) + "-0000-4000-8000-000000000000"
		item := body.Observations[id]
		if len(item) != 6 || string(item["taskVersion"]) != `"9223372036854775807"` || string(item["state"]) != `"`+state+`"` {
			t.Fatalf("observation %q: %s", id, item)
		}
		for _, key := range []string{"observedAt", "freshUntil", "needsAttention", "canOpen"} {
			if _, ok := item[key]; !ok {
				t.Fatalf("observation %q missing %s", id, key)
			}
		}
	}
	openUnknown := body.Observations["00000007-0000-4000-8000-000000000000"]
	if string(openUnknown["observedAt"]) != `"2026-11-14T12:00:00.000000123Z"` || string(openUnknown["freshUntil"]) != `"2026-11-14T12:00:30.000000123Z"` || string(openUnknown["needsAttention"]) != "false" || string(openUnknown["canOpen"]) != "true" {
		t.Fatalf("open unavailable fields: %s", openUnknown)
	}
	item := body.Observations[unavailableID]
	if string(item["observedAt"]) != "null" || string(item["freshUntil"]) != "null" || string(item["needsAttention"]) != "null" || string(item["canOpen"]) != "false" {
		t.Fatalf("unavailable fields: %s", item)
	}
}

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
	if len(fields) != 13 || string(fields["dependencyStates"]) != "{}" {
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
