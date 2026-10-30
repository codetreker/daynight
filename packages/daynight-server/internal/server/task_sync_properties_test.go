package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskSyncHTTPPropertiesSnapshotDeltaAndRemoval(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Private sync task")
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	if len(baseline.Tasks) != 1 || baseline.Tasks[0].Properties == nil || len(baseline.Tasks[0].Properties) != 0 {
		t.Fatalf("new task properties: %#v", baseline)
	}
	query := "?epoch=" + baseline.Epoch + "&since=" + url.QueryEscape(baseline.ObservedAt.Format(time.RFC3339Nano))
	propertyPath := taskPath(task) + "/properties/pullRequests"
	changed := propertyResource(t, handler, http.MethodPut, propertyPath, map[string]any{"version": task.Version, "valueText": `[{"url":"sync-private-value\u0000中文","title":"second"},{"url":"same","title":"second"}]`})
	check := func(expected api.PropertyResource) {
		t.Helper()
		for _, suffix := range []string{"", query} {
			response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+suffix, "")
			actual := decodeResponse[api.TaskSync](t, response, http.StatusOK)
			if actual.Epoch != baseline.Epoch || len(actual.Tasks) != 1 || actual.Tasks[0].Version != strconv.FormatInt(expected.Version, 10) || actual.Tasks[0].Properties == nil || !reflect.DeepEqual(actual.Tasks[0].Properties, expected.Properties) {
				t.Fatalf("properties not synchronized: %#v want %#v", actual, expected)
			}
			var raw struct {
				Tasks []map[string]json.RawMessage `json:"tasks"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
				t.Fatal(err)
			}
			if len(raw.Tasks) != 1 || raw.Tasks[0]["properties"] == nil || bytes.Equal(raw.Tasks[0]["properties"], []byte("null")) {
				t.Fatalf("missing property object: %s", response.Body)
			}
		}
	}
	check(changed)
	empty := propertyResource(t, handler, http.MethodPut, propertyPath, map[string]any{"version": changed.Version, "valueText": "[]"})
	check(empty)
	if _, exists := empty.Properties["pullRequests"]; !exists {
		t.Fatal("explicit [] lost presence")
	}
	removed := propertyResource(t, handler, http.MethodDelete, propertyPath, map[string]any{"version": empty.Version})
	check(removed)
	if _, exists := removed.Properties["pullRequests"]; exists {
		t.Fatal("remove retained key")
	}
	if strings.Contains(logs.String(), "sync-private-value") || strings.Contains(logs.String(), "Private sync task") {
		t.Fatalf("sync logs leaked values: %s", &logs)
	}
}

func TestTaskSyncHTTPRejectsIllegalStoredPropertiesWithoutPartialTasks(t *testing.T) {
	for _, test := range []struct{ name, property, value string }{
		{"json", "pullRequests", "["},
		{"shape", "pullRequests", `{"private-value":"hidden"}`},
		{"unknown", "private-unknown-property", `[]`},
		{"worker null", "worker", `null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := projectTestStore(t)
			var logs bytes.Buffer
			handler := projectTestHandler(t, database, &logs)
			project := taskProject(t, handler)
			createHTTPTask(t, handler, project.ID, "Valid sibling")
			corrupt := createHTTPTask(t, handler, project.ID, "Corrupt sibling")
			base := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
			if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, corrupt.ID, test.property, test.value); err != nil {
				t.Fatal(err)
			}
			for _, query := range []string{"", "?epoch=" + base.Epoch} {
				response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+query, "")
				assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
				var result map[string]json.RawMessage
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if _, present := result["tasks"]; present {
					t.Fatalf("partial task list escaped: %s", response.Body)
				}
			}
			if strings.Contains(logs.String(), "private-value") || strings.Contains(logs.String(), "private-unknown-property") || strings.Contains(logs.String(), "Corrupt sibling") {
				t.Fatalf("invalid property contents logged: %s", &logs)
			}
		})
	}
}

func TestTaskSyncHTTPPropertyStorageFailureRemainsInternal(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	createHTTPTask(t, handler, project.ID, "Target")
	if _, err := database.Pool.Exec(context.Background(), "DROP TABLE task_properties"); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, syncPath(project.ID), "")
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if strings.Contains(logs.String(), "SELECT task_id") {
		t.Fatalf("SQL leaked: %s", &logs)
	}
}
