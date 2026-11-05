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
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStepsHTTPExactCapacityStress(t *testing.T) {
	database, handler, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	steps := make([]model.TaskStep, 128)
	for index := range steps {
		steps[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
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

type stepWriteAudit struct{ shifts, inserts, touches atomic.Int64 }

func (audit *stepWriteAudit) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch {
	case strings.HasPrefix(data.SQL, "UPDATE task_steps SET position=position+1"):
		audit.shifts.Add(1)
	case strings.HasPrefix(data.SQL, "INSERT INTO task_steps"):
		audit.inserts.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE tasks SET version=version+1,updated_at=$3"):
		audit.touches.Add(1)
	}
	return ctx
}
func (*stepWriteAudit) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestStepsHTTPAddCapacityStress(t *testing.T) {
	database, _, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	steps := make([]model.TaskStep, 128)
	for index := range steps {
		steps[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	candidate := append(append([]model.TaskStep{}, steps...), model.TaskStep{ID: "ffffffff", Position: 128, Title: "New <&> 中文", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	_, base, err := tasksteps.EncodeCollection(header, candidate)
	if err != nil {
		t.Fatal(err)
	}
	remaining := tasksteps.MaxEncodedBytes - len(base)
	for index := range steps {
		size := min(remaining, 524288)
		steps[index].Description = strings.Repeat("X", size)
		remaining -= size
		row := steps[index]
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, task.ID, row.ID, row.Position, row.Title, row.Description, row.Status, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach candidate capacity")
	}
	audit := &stepWriteAudit{}
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = audit
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	traced := projectTestHandler(t, &store.Store{Pool: pool}, io.Discard)
	server := httptest.NewServer(traced)
	defer server.Close()
	path := taskPath(task) + "/steps"
	client := &http.Client{Timeout: 60 * time.Second}
	request := func(method, path, body string) (int, []byte) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+traced.token)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, tasksteps.MaxEncodedBytes+1))
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, data
	}
	reset := func(extra int) {
		t.Helper()
		if extra < 0 {
			t.Fatal("invalid fixture padding")
		}
		if _, err := database.Pool.Exec(context.Background(), `DELETE FROM task_steps WHERE task_id=$1 AND id='ffffffff'`, task.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64-1)); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET description=$2 WHERE task_id=$1 AND id='0000007f'`, task.ID, steps[127].Description+strings.Repeat("X", extra)); err != nil {
			t.Fatal(err)
		}
		audit.shifts.Store(0)
		audit.inserts.Store(0)
		audit.touches.Store(0)
	}
	body := `{"version":9223372036854775806,"id":"FFFFFFFF","title":"New <&> 中文"}`
	padding := 0
	history := make([]string, 0, 64)
	snapshot := `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`
	validateCreated := func(data []byte) {
		t.Helper()
		var resource api.StepsResource
		if err := json.Unmarshal(data, &resource); err != nil || len(resource.Steps) != 129 || resource.Version != math.MaxInt64 || resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || len(data) == 0 || data[len(data)-1] != '\n' {
			t.Fatal("invalid or incomplete calibration receipt", err)
		}
		for index, expected := range steps {
			actual := resource.Steps[index]
			description := expected.Description
			if index == 127 {
				description += strings.Repeat("X", padding)
			}
			if actual.ID != expected.ID || actual.Title != expected.Title || actual.Description != description || actual.Status != expected.Status || actual.CreatedAt != stamp || actual.UpdatedAt != stamp {
				t.Fatalf("calibration changed existing Step %d", index)
			}
		}
		added := resource.Steps[128]
		if added.ID != "ffffffff" || added.Title != "New <&> 中文" || added.Description != "" || added.Status != model.TaskStepTodo || added.CreatedAt.IsZero() || added.CreatedAt != added.UpdatedAt || added.CreatedAt.Nanosecond()%1000 != 0 || added.CreatedAt.Location() != time.UTC {
			t.Fatal("invalid new Step in calibration receipt")
		}
		if len(data) > tasksteps.MaxEncodedBytes || audit.shifts.Load() != 1 || audit.inserts.Load() != 1 || audit.touches.Load() != 1 {
			t.Fatal("successful calibration exceeded capacity or changed persistence stages")
		}
	}
	// Only complete confirmed receipts and unchanged known refusals calibrate the
	// isolated fixture. Actual RFC 3339 byte deltas account for any omitted zeros.
	calibrate := func(target int) []byte {
		t.Helper()
		for attempt := 0; attempt < 32; attempt++ {
			reset(padding)
			var before string
			if err := database.Pool.QueryRow(context.Background(), snapshot, task.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			status, data := request("POST", path, body)
			measured := 0
			switch status {
			case 201:
				validateCreated(data)
				measured = len(data)
			case 409:
				var refusal api.ErrorResponse
				if json.Unmarshal(data, &refusal) != nil || refusal.Error.Code != "steps_limit_exceeded" || refusal.Error.Details == nil || refusal.Error.Details.EncodedBytes == nil || refusal.Error.Details.MaxEncodedBytes == nil || *refusal.Error.Details.MaxEncodedBytes != tasksteps.MaxEncodedBytes || *refusal.Error.Details.EncodedBytes <= tasksteps.MaxEncodedBytes {
					t.Fatalf("invalid calibration refusal: %s", data)
				}
				measured = int(*refusal.Error.Details.EncodedBytes)
				if audit.shifts.Load() != 0 || audit.inserts.Load() != 0 || audit.touches.Load() != 0 {
					t.Fatal("capacity calibration refusal executed data changes")
				}
				var after string
				if err := database.Pool.QueryRow(context.Background(), snapshot, task.ID).Scan(&after); err != nil || after != before {
					t.Fatal("capacity calibration refusal changed rows, revision or timestamps", err)
				}
			default:
				t.Fatalf("unconfirmed calibration response: status=%d bytes=%d", status, len(data))
			}
			history = append(history, fmt.Sprintf("target=%d padding=%d status=%d measured=%d", target, padding, status, measured))
			if measured == target {
				return data
			}
			padding += target - measured
		}
		t.Fatalf("capacity calibration did not converge: %s", strings.Join(history, "; "))
		return nil
	}
	exact := calibrate(tasksteps.MaxEncodedBytes)
	getStatus, getData := request("GET", path, "")
	if getStatus != 200 || !bytes.Equal(exact, getData) {
		t.Fatal("boundary GET differs from the frozen POST bytes")
	}
	t.Logf("actual POST and GET each returned %d bytes, including terminal LF", len(exact))
	padding++
	refusal := calibrate(tasksteps.MaxEncodedBytes + 1)
	var response api.ErrorResponse
	if json.Unmarshal(refusal, &response) != nil || response.Error.Code != "steps_limit_exceeded" || *response.Error.Details.EncodedBytes != tasksteps.MaxEncodedBytes+1 {
		t.Fatal("one-byte-over response invalid")
	}
	t.Logf("one-byte-over POST refused %d bytes before all row/touch SQL", *response.Error.Details.EncodedBytes)
}
