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

type stepDeleteAudit struct{ clock, deletes, compactions, touches atomic.Int64 }

func (audit *stepDeleteAudit) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch {
	case data.SQL == "SELECT statement_timestamp()":
		audit.clock.Add(1)
	case strings.HasPrefix(data.SQL, "DELETE FROM task_steps WHERE"):
		audit.deletes.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE task_steps SET position=position-1 WHERE"):
		audit.compactions.Add(1)
	case strings.HasPrefix(data.SQL, "UPDATE tasks SET version=version+1,updated_at=$3"):
		audit.touches.Add(1)
	}
	return ctx
}
func (*stepDeleteAudit) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestStepsHTTPDeleteCapacityStress(t *testing.T) {
	database, _, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	rows := make([]model.TaskStep, 128)
	for index := range rows {
		rows[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: math.MaxInt64}
	_, base, err := tasksteps.EncodeCollection(header, rows)
	if err != nil {
		t.Fatal(err)
	}
	remaining := tasksteps.MaxEncodedBytes - len(base)
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
		t.Fatal("fixture did not reach legal exact capacity")
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64-1)); err != nil {
		t.Fatal(err)
	}
	audit := &stepDeleteAudit{}
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = audit
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	handler := projectTestHandler(t, &store.Store{Pool: pool}, io.Discard)
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
		data, err := io.ReadAll(io.LimitReader(response.Body, tasksteps.MaxEncodedBytes+1))
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, data
	}
	status, before := request("GET", "", "")
	if status != 200 || len(before) != tasksteps.MaxEncodedBytes {
		t.Fatal("initial legal collection did not reach exact capacity")
	}
	deletedIndex := 63
	status, data := request("DELETE", "/0000003F", `{"version":9223372036854775806}`)
	if status != 200 || len(data) >= len(before) || data[len(data)-1] != '\n' {
		t.Fatalf("actual large delete status=%d bytes=%d", status, len(data))
	}
	var resource api.StepsResource
	if json.Unmarshal(data, &resource) != nil || resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != math.MaxInt64 || len(resource.Steps) != len(rows)-1 {
		t.Fatal("large deletion returned incomplete remaining resource")
	}
	expectedRows := make([]model.TaskStep, 0, len(rows)-1)
	for index, row := range rows {
		if index == deletedIndex {
			continue
		}
		expectedRows = append(expectedRows, row)
	}
	for index, step := range resource.Steps {
		expected := expectedRows[index]
		expectedRows[index].Position = int64(index)
		if step.ID != expected.ID || step.Title != expected.Title || step.Description != expected.Description || step.Status != expected.Status || step.CreatedAt != expected.CreatedAt || step.UpdatedAt != expected.UpdatedAt {
			t.Fatalf("large deletion changed retained record at %d", index)
		}
	}
	_, encoded, err := tasksteps.EncodeCollection(header, expectedRows)
	if err != nil || !bytes.Equal(data, encoded) {
		t.Fatal("large deletion bytes differ from complete expected codec resource", err)
	}
	if audit.clock.Load() != 1 || audit.deletes.Load() != 1 || audit.compactions.Load() != 1 || audit.touches.Load() != 1 {
		t.Fatal("delete did not use one target/tail/parent write")
	}
	getStatus, getData := request("GET", "", "")
	if getStatus != 200 || !bytes.Equal(data, getData) {
		t.Fatal("large remaining GET differs from frozen DELETE response")
	}
	itemStatus, _ := request("GET", "/0000003f", "")
	if itemStatus != 404 {
		t.Fatal("deleted large-record identity is still visible")
	}
	t.Logf("legal %d-byte collection DELETE returned complete %d-byte remaining resource; GET identical;127 retained fields/times and dense order verified", len(before), len(data))
}
