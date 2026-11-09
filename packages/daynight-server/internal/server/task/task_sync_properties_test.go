package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskSyncHTTPPropertiesSnapshotDeltaAndRemoval(t *testing.T) {
	for _, tc := range []struct {
		name       string
		properties model.TaskProperties
	}{
		{"new", model.TaskProperties{}},
		{"set", model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"sync-private-value\u0000中文","title":"second"},{"url":"same","title":"second"}]`)}},
		{"explicit empty", model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}},
		{"removed", model.TaskProperties{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			handler := newHTTPFixture(t, &logs)
			result := syncModel()
			result.Tasks = []model.TaskViewRecord{{ID: testTaskID, TitlePreview: "Private sync task", Status: model.TaskTodo, Version: 9007199254740993, Properties: tc.properties, CreatedAt: testTime, UpdatedAt: testTime}}
			calls := 0
			handler.ExpectCalls("Sync", 2)
			handler.Sync = func(ctx context.Context, principal model.Principal, pid string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
				calls++
				if principal != handler.principal || pid != testProjectID {
					t.Fatalf("sync identity=%+v %s", principal, pid)
				}
				if calls == 1 {
					if input.Epoch != "" || input.Since != nil {
						t.Fatalf("snapshot=%+v", input)
					}
					result.Mode = "snapshot"
				} else {
					if input.Epoch != testEpoch || input.Since == nil || !input.Since.Equal(result.ObservedAt) {
						t.Fatalf("delta=%+v", input)
					}
					result.Mode = "delta"
				}
				return result, nil
			}
			for _, suffix := range []string{"", "?epoch=" + testEpoch + "&since=" + url.QueryEscape(result.ObservedAt.Format(time.RFC3339Nano))} {
				response := projectRequest(handler, http.MethodGet, syncPath(testProjectID)+suffix, "")
				actual := decodeResponse[api.TaskSync](t, response, 200)
				if actual.Epoch != testEpoch || len(actual.Tasks) != 1 || actual.Tasks[0].Version != strconv.FormatInt(result.Tasks[0].Version, 10) || actual.Tasks[0].Properties == nil || !reflect.DeepEqual(actual.Tasks[0].Properties, api.TaskProperties(tc.properties)) {
					t.Fatalf("properties=%+v want=%+v", actual, tc.properties)
				}
				var raw struct {
					Tasks []map[string]json.RawMessage `json:"tasks"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
					t.Fatal(err)
				}
				if len(raw.Tasks) != 1 || raw.Tasks[0]["properties"] == nil || bytes.Equal(raw.Tasks[0]["properties"], []byte("null")) {
					t.Fatalf("missing object=%s", response.Body)
				}
			}
			if calls != 2 || strings.Contains(logs.String(), "sync-private-value") || strings.Contains(logs.String(), "Private sync task") {
				t.Fatalf("calls=%d logs=%s", calls, &logs)
			}
		})
	}
}

func TestTaskSyncHTTPPropertyEncodingFailureDoesNotSendPartialTasks(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	result := syncModel()
	result.Tasks = []model.TaskViewRecord{{ID: testTaskID, TitlePreview: "Private sync task", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`not JSON`)}, CreatedAt: testTime, UpdatedAt: testTime}}
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return result, nil
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if strings.Contains(response.Body.String(), `"tasks"`) || strings.Contains(logs.String(), "not JSON") || strings.Contains(logs.String(), "Private sync task") {
		t.Fatalf("partial tasks or values escaped: body=%s logs=%s", response.Body, &logs)
	}
}

func TestTaskSyncHTTPPropertyStorageFailureRemainsInternal(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return model.TaskSync{}, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("SELECT task_id FROM private_task_properties")}
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	assertProjectError(t, response, 500, "internal_error")
	if strings.Contains(response.Body.String(), "SELECT task_id") || strings.Contains(logs.String(), "SELECT task_id") {
		t.Fatalf("SQL leaked body=%s logs=%s", response.Body, &logs)
	}
}
