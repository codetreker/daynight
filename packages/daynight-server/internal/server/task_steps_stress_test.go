//go:build stress

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
)

func TestStepsHTTPExactCapacityStress(t *testing.T) {
	database, handler, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	header := core.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	steps := make([]core.TaskStep, 128)
	for index := range steps {
		steps[index] = core.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: core.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	_, base, err := tasksteps.EncodeCollection(header, steps)
	if err != nil {
		t.Fatal(err)
	}
	remaining := tasksteps.MaxEncodedBytes - len(base)
	for index := range steps {
		size := min(remaining, 524288)
		steps[index].Description = strings.Repeat("X", size)
		remaining -= size
		step := steps[index]
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
			task.ID, step.ID, step.Position, step.Title, step.Description, step.Status, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach capacity")
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	path := "/api/v1/projects/" + task.ProjectID + "/tasks/" + task.ID + "/steps"
	read := func(status, size int, version int64) {
		t.Helper()
		request, err := http.NewRequest("GET", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+handler.token)
		response, err := (&http.Client{Timeout: 45 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, tasksteps.MaxEncodedBytes+1))
		if err != nil || response.StatusCode != status {
			t.Fatalf("HTTP boundary: status=%d bytes=%d error=%v", response.StatusCode, len(data), err)
		}
		if status != 200 {
			return
		}
		if len(data) != size || data[len(data)-1] != '\n' || !bytes.Contains(data, []byte(`"version":`+strconv.FormatInt(version, 10))) || !bytes.Contains(data, []byte(`\u003c中文\u0026\u003e\u2028\u2029`)) {
			t.Fatalf("wire bytes=%d expected=%d", len(data), size)
		}
		var resource api.StepsResource
		if err := json.Unmarshal(data, &resource); err != nil || len(resource.Steps) != len(steps) || resource.Version != version {
			t.Fatalf("complete resource: %v", err)
		}
		for index, expected := range steps {
			actual := resource.Steps[index]
			if actual.ID != expected.ID || actual.Description != expected.Description || actual.Title != expected.Title || actual.CreatedAt != stamp || actual.UpdatedAt != stamp {
				t.Fatalf("resource mismatch at %d", index)
			}
		}
	}
	read(200, tasksteps.MaxEncodedBytes, math.MaxInt64)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=1 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	read(200, tasksteps.MaxEncodedBytes-18, 1)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET description=description||'X' WHERE task_id=$1 AND id='0000007f'`, task.ID); err != nil {
		t.Fatal(err)
	}
	read(500, 0, 1)
}
