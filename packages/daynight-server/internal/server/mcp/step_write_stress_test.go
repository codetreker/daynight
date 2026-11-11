//go:build stress

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// The first full collection read is held inside the real mutation, after the
// MCP large permit has been acquired. Competing calls must be refused before
// reaching this read, including when they ask for summary results.
type stressStepsGate struct {
	enabled atomic.Bool
	reads   atomic.Int64
	entered chan struct{}
	release chan struct{}
}

func (g *stressStepsGate) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if g.enabled.Load() && q.SQL == `SELECT id,position,title,description,status,created_at,updated_at FROM task_steps WHERE task_id=$1 ORDER BY position` {
		if g.reads.Add(1) == 1 {
			close(g.entered)
			select {
			case <-g.release:
			case <-ctx.Done():
			}
		}
	}
	return ctx
}
func (*stressStepsGate) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type stressStepsResponse struct {
	Data struct {
		Version    string `json:"version"`
		Changed    bool   `json:"changed"`
		Projection string `json:"projection"`
	} `json:"data"`
	Error struct {
		Code         string `json:"code"`
		WriteOutcome string `json:"writeOutcome"`
	} `json:"error"`
}

func stressStepCall(ctx context.Context, session *sdk.ClientSession, name string, args map[string]any) (stressStepsResponse, bool, error) {
	var out stressStepsResponse
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return out, false, err
	}
	b, err := json.Marshal(result.StructuredContent)
	if err == nil {
		err = json.Unmarshal(b, &out)
	}
	return out, result.IsError, err
}

func TestStressMCPStepsCapacityAndConcurrentSummaryHeap(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	base := testutil.OpenStore(t, postgres.Open)
	gate := &stressStepsGate{entered: make(chan struct{}), release: make(chan struct{})}
	cfg := base.Pool.Config().Copy()
	cfg.ConnConfig.Tracer = gate
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	db := &postgres.Store{Pool: pool}
	_, principal, _ := testutil.AuthRecords(t, db)
	project, err := testutil.CreatePrivateProject(t.Context(), db, principal, testutil.QueryID(1), "Stress Steps", "https://example.com/stress-steps")
	if err != nil {
		t.Fatal(err)
	}
	task, err := taskservice.NewTasks(db).Create(t.Context(), principal, project.ID, taskcore.CreateTask{Title: "Parent"})
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(db, nil, "")
	pat, err := identity.CreatePAT(t.Context(), principal, identitycore.CreatePAT{Name: "Stress Steps"})
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 0, time.UTC)
	header := model.TaskHeader{ProjectID: project.ID, ID: task.ID, Version: math.MaxInt64}
	items := make([]model.TaskStep, 128)
	for i := range items {
		items[i] = model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: "A", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
	}
	_, empty, err := taskcodec.EncodeCollection(header, items)
	if err != nil {
		t.Fatal(err)
	}
	remaining := taskcodec.MaxEncodedBytes - len(empty)
	sizes := make([]int, len(items))
	for i := range items {
		size := min(remaining, 524288)
		// The updated target must satisfy the current per-Step text budget.
		// Keep the exact collection size by placing its bytes in the last row.
		if i == 0 {
			size = 0
		} else if i == len(items)-1 {
			size = remaining
		}
		sizes[i] = size
		remaining -= size
		_, err := pool.Exec(t.Context(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,'A',repeat('X',$4),'todo',$5,$5)`, task.ID, items[i].ID, i, size, stamp)
		if err != nil {
			t.Fatal(err)
		}
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach capacity")
	}
	steps := taskservice.NewTaskSteps(db)
	server, _ := newAdapterHost(t, identity, io.Discard, func(entry *Entry, _ string) error {
		if err := RegisterStepReadTools(entry, steps); err != nil {
			return err
		}
		return RegisterStepWriteTools(entry, steps)
	})
	session := mcpPATClient(t, server.URL, pat.Secret)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	args := map[string]any{"projectId": project.ID, "taskId": task.ID, "stepId": "00000000", "position": "last", "ifVersion": "1", "returnView": "summary"}
	runtime.GC()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	var peak atomic.Uint64
	peak.Store(baseline.HeapAlloc)
	stopSample := make(chan struct{})
	sampleDone := make(chan struct{})
	go func() {
		defer close(sampleDone)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			for old := peak.Load(); m.HeapAlloc > old && !peak.CompareAndSwap(old, m.HeapAlloc); old = peak.Load() {
			}
			select {
			case <-stopSample:
				return
			case <-ticker.C:
			}
		}
	}()
	gate.enabled.Store(true)
	type reply struct {
		value  stressStepsResponse
		failed bool
		err    error
	}
	first := make(chan reply, 1)
	go func() {
		v, failed, err := stressStepCall(ctx, session, "task_step_move", args)
		first <- reply{v, failed, err}
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		close(gate.release)
		close(stopSample)
		<-sampleDone
		t.Fatal("timed out waiting for mutation")
	}
	for i := 0; i < 4; i++ {
		v, failed, err := stressStepCall(ctx, session, "task_step_move", args)
		if err != nil || !failed || v.Error.Code != "resource_busy" || gate.reads.Load() != 1 {
			close(gate.release)
			close(stopSample)
			<-sampleDone
			t.Fatalf("competing summary write reached the collection: %+v failed=%v err=%v reads=%d", v, failed, err, gate.reads.Load())
		}
	}
	close(gate.release)
	var response reply
	select {
	case response = <-first:
	case <-ctx.Done():
		close(stopSample)
		<-sampleDone
		t.Fatal("timed out waiting for write")
	}
	close(stopSample)
	<-sampleDone
	if response.err != nil || response.failed || !response.value.Data.Changed || response.value.Data.Version != "2" || response.value.Data.Projection != "summary" {
		t.Fatalf("capacity boundary receipt: %+v", response)
	}
	peakHeap := peak.Load()
	delta := peakHeap - baseline.HeapAlloc
	t.Logf("64 MiB Step resource; baseline Go heap=%d, sampled peak=%d, increase=%d bytes", baseline.HeapAlloc, peakHeap, delta)
	if delta > 512<<20 {
		t.Fatalf("sampled Go heap increase exceeds 512 MiB: %d", delta)
	}
	// The exact-capacity move does not alter timestamps or content. Growing the
	// title by one byte (and updating its timestamp) must be refused atomically.
	gate.enabled.Store(false)
	v, failed, err := stressStepCall(ctx, session, "task_step_update", map[string]any{"projectId": project.ID, "taskId": task.ID, "stepId": "00000000", "title": "AA", "ifVersion": "2", "returnView": "summary"})
	if err != nil || !failed || v.Error.Code != "steps_limit_exceeded" || v.Error.WriteOutcome != "not_committed" {
		t.Fatalf("over-capacity write: %+v failed=%v err=%v", v, failed, err)
	}
	var version int64
	var title string
	var position int64
	if err := pool.QueryRow(ctx, `SELECT t.version,s.title,s.position FROM tasks t JOIN task_steps s ON s.task_id=t.id WHERE t.id=$1 AND s.id='00000000'`, task.ID).Scan(&version, &title, &position); err != nil || version != 2 || title != "A" || position != 127 {
		t.Fatalf("refusal changed task: version=%d title=%q position=%d err=%v", version, title, position, err)
	}
	// Receive the maximum admitted resource over both actual MCP protocols.
	// Run sequentially, since the SDK client and server share this test process.
	for i, protocol := range []string{"2025-11-25", "2026-07-28"} {
		runtime.GC()
		client := sdk.NewClient(&sdk.Implementation{Name: "mcp-steps-capacity", Version: "1"}, nil)
		connection, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: headerTransport{base: http.DefaultTransport, token: pat.Secret}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
		if err != nil {
			t.Fatalf("%s connection: %v", protocol, err)
		}
		position := "first"
		if i == 1 {
			position = "last"
		}
		result, callErr := connection.CallTool(ctx, &sdk.CallToolParams{Name: "task_step_move", Arguments: map[string]any{"projectId": project.ID, "taskId": task.ID, "stepId": "00000000", "position": position, "ifVersion": fmt.Sprint(i + 2), "returnView": "full"}})
		closeErr := connection.Close()
		if callErr != nil || closeErr != nil || result == nil || result.IsError {
			t.Fatalf("%s full result: call=%v close=%v resultError=%v", protocol, callErr, closeErr, result != nil && result.IsError)
		}
		envelope, ok := result.StructuredContent.(map[string]any)
		if !ok {
			t.Fatalf("%s: missing structured envelope", protocol)
		}
		data, ok := envelope["data"].(map[string]any)
		if !ok || data["projectId"] != project.ID || data["taskId"] != task.ID || data["stepId"] != "00000000" || data["version"] != fmt.Sprint(i+3) || data["projection"] != "full" || data["changed"] != true {
			t.Fatalf("%s: invalid full receipt metadata", protocol)
		}
		steps, ok := data["steps"].([]any)
		if !ok || len(steps) != len(items) {
			t.Fatalf("%s: expected %d complete Steps, received %d", protocol, len(items), len(steps))
		}
		for j, value := range steps {
			index := j
			if i == 1 {
				index = (j + 1) % len(items)
			}
			step, ok := value.(map[string]any)
			if !ok {
				t.Fatalf("%s: Step %d is not an object", protocol, j)
			}
			description, ok := step["description"].(string)
			if !ok || len(description) != sizes[index] || strings.Trim(description, "X") != "" || step["id"] != items[index].ID || step["title"] != "A" || step["status"] != "todo" || step["createdAt"] != stamp.Format(time.RFC3339) || step["updatedAt"] != stamp.Format(time.RFC3339) {
				t.Fatalf("%s: Step %d content or order differs from fixture", protocol, j)
			}
		}
		t.Logf("%s received full 64 MiB Step resource at version %d", protocol, i+3)
	}
}
