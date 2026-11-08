//go:build stress

package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type stepChangeAudit struct{ clock, updates, touches atomic.Int64 }

func (audit *stepChangeAudit) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch {
	case data.SQL == "SELECT statement_timestamp()":
		audit.clock.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE task_steps SET title="):
		audit.updates.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE tasks SET version=version+1,updated_at=$3"):
		audit.touches.Add(1)
	}
	return ctx
}
func (*stepChangeAudit) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (audit *stepChangeAudit) reset() {
	audit.clock.Store(0)
	audit.updates.Store(0)
	audit.touches.Store(0)
}

func TestStressStepsHTTPChangeCapacityStress(t *testing.T) {
	database, _, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	rows := make([]model.TaskStep, 129)
	for index := range rows {
		rows[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "Old <中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	title, description := "Changed <&> 中文", strings.Repeat("N", 64)
	candidate := append([]model.TaskStep{}, rows...)
	candidate[0].Title = title
	candidate[0].Description = description
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	_, base, err := taskcodec.EncodeCollection(header, candidate)
	if err != nil {
		t.Fatal(err)
	}
	remaining := taskcodec.MaxEncodedBytes - len(base)
	for index := range rows {
		if index != 0 {
			size := min(remaining, 524288)
			rows[index].Description = strings.Repeat("X", size)
			remaining -= size
		}
		row := rows[index]
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, task.ID, row.ID, row.Position, row.Title, row.Description, row.Status, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach candidate capacity")
	}
	audit := &stepChangeAudit{}
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = audit
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	handler := projectTestHandler(t, &postgres.Store{Pool: pool}, io.Discard)
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Timeout: 60 * time.Second}
	path := taskPath(task) + "/steps"
	request := func(method, suffix, body string) (int, []byte) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path+suffix, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+handler.token)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, taskcodec.MaxEncodedBytes+1))
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, data
	}
	snapshot := func() string {
		t.Helper()
		var state string
		if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	padding := 0
	reset := func() {
		t.Helper()
		if padding < 0 {
			t.Fatal("invalid fixture padding")
		}
		if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64-1)); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET title=$2,description='',status='todo',updated_at=$3 WHERE task_id=$1 AND id='00000000'`, task.ID, rows[0].Title, stamp); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET description=$2,updated_at=$3 WHERE task_id=$1 AND id='00000080'`, task.ID, rows[128].Description+strings.Repeat("X", padding), stamp); err != nil {
			t.Fatal(err)
		}
		audit.reset()
	}
	body := jsonBody(t, map[string]any{"version": int64(math.MaxInt64 - 1), "title": title, "description": description})
	history := make([]string, 0, 64)
	validate := func(data []byte) {
		t.Helper()
		var resource api.StepsResource
		if json.Unmarshal(data, &resource) != nil || resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != math.MaxInt64 || len(resource.Steps) != len(rows) || len(data) == 0 || data[len(data)-1] != '\n' {
			t.Fatal("invalid or incomplete calibration receipt")
		}
		for index, expected := range rows {
			actual := resource.Steps[index]
			if index == 128 {
				expected.Description += strings.Repeat("X", padding)
			}
			if actual.ID != expected.ID || actual.CreatedAt != expected.CreatedAt || actual.Status != expected.Status {
				t.Fatalf("calibration identity/status mismatch at %d", index)
			}
			if index == 0 {
				if actual.Title != title || actual.Description != description || actual.UpdatedAt.IsZero() || actual.UpdatedAt.Nanosecond()%1000 != 0 {
					t.Fatal("target fields/timestamp invalid")
				}
			} else if actual.Title != expected.Title || actual.Description != expected.Description || actual.UpdatedAt != expected.UpdatedAt {
				t.Fatalf("calibration changed other row %d", index)
			}
		}
		if len(data) > taskcodec.MaxEncodedBytes || audit.clock.Load() != 1 || audit.updates.Load() != 1 || audit.touches.Load() != 1 {
			t.Fatal("successful calibration exceeded capacity or persistence stages")
		}
	}
	calibrate := func(target int) []byte {
		t.Helper()
		for attempt := 0; attempt < 32; attempt++ {
			reset()
			before := snapshot()
			status, data := request("PATCH", "/00000000", body)
			measured := 0
			switch status {
			case 200:
				validate(data)
				measured = len(data)
			case 409:
				var refusal api.ErrorResponse
				if json.Unmarshal(data, &refusal) != nil || refusal.Error.Code != "steps_limit_exceeded" || refusal.Error.Details == nil || refusal.Error.Details.EncodedBytes == nil || refusal.Error.Details.MaxEncodedBytes == nil || *refusal.Error.Details.MaxEncodedBytes != taskcodec.MaxEncodedBytes || *refusal.Error.Details.EncodedBytes <= taskcodec.MaxEncodedBytes {
					t.Fatal("invalid calibration refusal")
				}
				measured = int(*refusal.Error.Details.EncodedBytes)
				if audit.updates.Load() != 0 || audit.touches.Load() != 0 || snapshot() != before {
					t.Fatal("capacity refusal changed target, parent, order or timestamps")
				}
			default:
				t.Fatalf("unconfirmed calibration response: status=%d bytes=%d", status, len(data))
			}
			history = append(history, fmt.Sprintf("target=%d padding=%d status=%d bytes=%d", target, padding, status, measured))
			if measured == target {
				return data
			}
			padding += target - measured
		}
		t.Fatalf("capacity calibration did not converge: %s", strings.Join(history, "; "))
		return nil
	}
	exact := calibrate(taskcodec.MaxEncodedBytes)
	status, data := request("GET", "", "")
	if status != 200 || !bytes.Equal(exact, data) {
		t.Fatal("exact GET differs from PATCH frozen collection")
	}
	before := snapshot()
	audit.reset()
	status, data = request("PATCH", "/00000000", jsonBody(t, map[string]any{"version": int64(math.MaxInt64), "title": title, "description": description}))
	if status != 200 || !bytes.Equal(exact, data) || snapshot() != before || audit.clock.Load() != 0 || audit.updates.Load() != 0 || audit.touches.Load() != 0 {
		t.Fatal("maximum legal no-op sampled clock or changed stored state")
	}
	t.Logf("PATCH and GET returned exactly %d bytes; maximum-version no-op preserved every byte without clock/update/touch", len(exact))
	padding++
	calibrate(taskcodec.MaxEncodedBytes + 1)
	t.Logf("one-byte-over content candidate refused %d bytes before target update and parent touch", taskcodec.MaxEncodedBytes+1)
	status, large := request("GET", "", "")
	if status != 200 {
		t.Fatal("legal pre-change collection is unreadable")
	}
	audit.reset()
	status, small := request("PATCH", "/00000080", `{"version":9223372036854775806,"description":""}`)
	var shrunk api.StepsResource
	if status != 200 || json.Unmarshal(small, &shrunk) != nil || shrunk.Version != math.MaxInt64 || len(shrunk.Steps) != len(rows) || shrunk.Steps[128].Description != "" || len(small) >= len(large) || audit.updates.Load() != 1 || audit.touches.Load() != 1 {
		t.Fatal("large description shrink failed")
	}
	t.Logf("description shrink reduced complete response from %d to %d bytes", len(large), len(small))
	// Build a legal exact-capacity current collection with a whole-second target
	// timestamp, so a longer status always increases the next encoded candidate.
	reset()
	zeroStamp := stamp.Truncate(time.Second)
	current := append([]model.TaskStep{}, rows...)
	current[0].Status = model.TaskStepDone
	current[0].UpdatedAt = zeroStamp
	current[128].Description += strings.Repeat("X", padding)
	_, currentJSON, err := taskcodec.EncodeCollection(header, current)
	if err != nil {
		t.Fatal(err)
	}
	extra := taskcodec.MaxEncodedBytes - len(currentJSON)
	if extra < 0 {
		t.Fatal("status fixture is over capacity")
	}
	current[128].Description += strings.Repeat("X", extra)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET status='done',updated_at=$2 WHERE task_id=$1 AND id='00000000'`, task.ID, zeroStamp); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET description=$2 WHERE task_id=$1 AND id='00000080'`, task.ID, current[128].Description); err != nil {
		t.Fatal(err)
	}
	status, data = request("GET", "", "")
	if status != 200 || len(data) != taskcodec.MaxEncodedBytes {
		t.Fatal("status fixture was not legal exact capacity")
	}
	before = snapshot()
	audit.reset()
	status, data = request("PUT", "/00000000/status", `{"version":9223372036854775806,"status":"in_progress"}`)
	var refusal api.ErrorResponse
	if status != 409 || json.Unmarshal(data, &refusal) != nil || refusal.Error.Code != "steps_limit_exceeded" || refusal.Error.Details == nil || *refusal.Error.Details.EncodedBytes < taskcodec.MaxEncodedBytes+7 || audit.updates.Load() != 0 || audit.touches.Load() != 0 || snapshot() != before {
		t.Fatal("status growth bypassed full candidate capacity or changed data")
	}
	t.Logf("longer status refused complete candidate of %d bytes with zero changes", *refusal.Error.Details.EncodedBytes)
}
