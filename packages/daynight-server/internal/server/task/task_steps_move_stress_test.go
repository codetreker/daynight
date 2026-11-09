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

type stepMoveAudit struct{ clock, positions, touches atomic.Int64 }

func (audit *stepMoveAudit) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch {
	case data.SQL == "SELECT statement_timestamp()":
		audit.clock.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE task_steps SET position=CASE"):
		audit.positions.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE tasks SET version=version+1,updated_at=$3"):
		audit.touches.Add(1)
	}
	return ctx
}
func (*stepMoveAudit) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (audit *stepMoveAudit) reset() {
	audit.clock.Store(0)
	audit.positions.Store(0)
	audit.touches.Store(0)
}

func TestStressStepsHTTPMoveCapacityStress(t *testing.T) {
	database, _, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	rows := make([]model.TaskStep, 128)
	for index := range rows {
		rows[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	_, base, err := taskcodec.EncodeCollection(header, rows)
	if err != nil {
		t.Fatal(err)
	}
	remaining := taskcodec.MaxEncodedBytes - len(base)
	for index := range rows {
		size := min(remaining, 524288)
		rows[index].Description = strings.Repeat("X", size)
		remaining -= size
		row := rows[index]
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, task.ID, row.ID, row.Position, row.Title, row.Description, row.Status, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach exact capacity")
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64-1)); err != nil {
		t.Fatal(err)
	}
	audit := &stepMoveAudit{}
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
	status, data := request("PUT", "/00000000/position", `{"version":9223372036854775806,"position":"last"}`)
	if status != 200 || len(data) != taskcodec.MaxEncodedBytes || data[len(data)-1] != '\n' {
		t.Fatalf("actual move boundary status=%d bytes=%d", status, len(data))
	}
	var moved api.StepsResource
	if json.Unmarshal(data, &moved) != nil || moved.Version != math.MaxInt64 || moved.ProjectID != task.ProjectID || moved.TaskID != task.ID || len(moved.Steps) != len(rows) {
		t.Fatal("move boundary returned incomplete resource")
	}
	for index, step := range moved.Steps {
		expected := rows[(index+1)%len(rows)]
		if step.ID != expected.ID || step.Title != expected.Title || step.Description != expected.Description || step.Status != expected.Status || step.CreatedAt != expected.CreatedAt || step.UpdatedAt != expected.UpdatedAt {
			t.Fatalf("move changed non-position fields at %d", index)
		}
	}
	if audit.clock.Load() != 1 || audit.positions.Load() != 1 || audit.touches.Load() != 1 {
		t.Fatal("real move did not use one interval update and parent touch")
	}
	getStatus, getData := request("GET", "", "")
	if getStatus != 200 || !bytes.Equal(data, getData) {
		t.Fatal("boundary GET differs from frozen move bytes")
	}
	snapshot := func() string {
		t.Helper()
		var state string
		if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	audit.reset()
	noopStatus, noop := request("PUT", "/00000000/position", `{"version":9223372036854775807,"position":"last"}`)
	if noopStatus != 200 || !bytes.Equal(data, noop) || snapshot() != before || audit.clock.Load() != 0 || audit.positions.Load() != 0 || audit.touches.Load() != 0 {
		t.Fatal("maximum-version maximum-capacity no-op changed state or sampled clock")
	}
	t.Logf("actual position PUT and GET each returned %d bytes; every Step field/time preserved; MaxInt64 no-op identical with zero clock/position/touch", len(data))
}
