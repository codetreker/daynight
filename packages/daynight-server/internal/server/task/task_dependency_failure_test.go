package task_test

import (
	"bytes"
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskAndSyncHTTPRecoverAfterDependencyTableFailure(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	predecessor := createHTTPTask(t, handler, project.ID, "Prerequisite")
	task := createHTTPTask(t, handler, project.ID, "Dependent", predecessor.ID)
	syncURL := syncPath(project.ID)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncURL, ""), http.StatusOK)
	if len(baseline.Tasks) != 2 {
		t.Fatalf("baseline sync: %+v", baseline)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE task_dependencies RENAME TO private_missing_dependencies`); err != nil {
		t.Fatal(err)
	}
	renamed := true
	t.Cleanup(func() {
		if renamed {
			cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if _, err := database.Pool.Exec(cleanup, `ALTER TABLE private_missing_dependencies RENAME TO task_dependencies`); err != nil {
				t.Error(err)
			}
		}
	})
	for _, path := range []string{taskPath(task), syncURL} {
		response := projectRequest(handler, http.MethodGet, path, "")
		failure := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
		if failure.Error.Code != "internal_error" || failure.Error.RequestID == "" || failure.Error.RequestID != response.Header().Get("X-Request-ID") || strings.Contains(response.Body.String(), "task_dependencies") || strings.Contains(response.Body.String(), "private_missing_dependencies") {
			t.Fatalf("unsafe or uncorrelated dependency failure: %s", response.Body)
		}
	}
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE private_missing_dependencies RENAME TO task_dependencies`); err != nil {
		t.Fatal(err)
	}
	renamed = false
	if read := readHTTPTask(t, handler, task); !reflect.DeepEqual(read, task) {
		t.Fatalf("task changed after recovery: %+v", read)
	}
	recovered := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncURL, ""), http.StatusOK)
	if recovered.Epoch != baseline.Epoch || recovered.Mode != baseline.Mode || recovered.Project != baseline.Project || !reflect.DeepEqual(recovered.Tasks, baseline.Tasks) {
		t.Fatal("sync did not recover its prior task projection")
	}
	if strings.Contains(logs.String(), "private_missing_dependencies") || strings.Contains(logs.String(), "task_dependencies") {
		t.Fatal("dependency table details leaked into logs")
	}
}
