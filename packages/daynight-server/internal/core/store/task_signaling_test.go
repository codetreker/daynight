package store

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func TestWorkerSignalingMigrationPreservesOpaquePropertiesAndTaskFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	worker := `{"claimId":"00000000-0000-4000-8000-000000000001","state":"active","userId":"00000000-0000-4000-8000-000000000002","workerId":"00000000-0000-4000-8000-000000000003","machine":{"id":"00000000-0000-4000-8000-000000000004","name":"Build"},"platform":"linux","agent":"codex","agentControlMode":"herdr","worktreeId":"00000000-0000-4000-8000-000000000005","phase":"executing","herdr":null,"nativeSessionId":"native","claimedAt":"2026-10-24T01:02:03Z"}`
	prs := `[{"url":"\u0000","title":"\ud800 and \"worker\":{ and \"signaling\":\"x\""}]`
	inputs := []string{
		`{"pullRequests":` + prs + `,"worker":` + worker + `}`,
		`{"pullRequests":` + prs + `,"worker":null}`,
		`{"pullRequests":[], "worker" : ` + strings.Replace(worker, `"state":"active"`, `"state":"released"`, 1) + `}`,
	}
	for i, properties := range inputs {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,version,properties) VALUES($1,$2,'Signaling migration',$3,9007199254740993,$4)`, queryID(10+i), project.ID, []string{"in_progress", "todo", "todo"}[i], properties)
	}
	before := workerMigrationRows(t, database)
	for range 2 {
		if err := migrate(ctx, pool, schemaMigrations); err != nil {
			t.Fatal(err)
		}
		after := workerMigrationRows(t, database)
		for i, row := range after {
			if row.OtherFacts != before[i].OtherFacts || row.ID != before[i].ID {
				t.Fatal("signaling migration changed identity, task version, timestamps or status")
			}
			var original, updated map[string]json.RawMessage
			if err := json.Unmarshal([]byte(inputs[i]), &original); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(row.Properties), &updated); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(original["pullRequests"], updated["pullRequests"]) {
				t.Fatal("signaling migration rewrote opaque PR JSON")
			}
			properties, err := taskproperties.Decode([]byte(row.Properties))
			if err != nil || (properties.Worker != nil && properties.Worker.Signaling != "") {
				t.Fatalf("migrated worker has invalid signaling: %#v %v", properties.Worker, err)
			}
			if i == 1 && row.Properties != inputs[i] {
				t.Fatal("null worker was rewritten")
			}
			var attention bool
			if err := pool.QueryRow(ctx, "SELECT worker_needs_attention FROM tasks WHERE id=$1", row.ID).Scan(&attention); err != nil || attention {
				t.Fatalf("existing task incorrectly needs attention: %v %v", attention, err)
			}
		}
	}
}

func TestTaskSignalingProjectionFollowsAtomicTaskWrites(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := context.Background()
	worker := &core.WorkerClaim{
		ClaimID: queryID(2), State: core.WorkerActive, UserID: queryID(3), WorkerID: queryID(4),
		Machine: core.WorkerMachine{ID: queryID(5), Name: "Test"}, Platform: core.PlatformLinux,
		Agent: core.AgentCodex, AgentControlMode: core.AgentControlModeHerdr, WorktreeID: queryID(6),
		Phase: core.WorkerExecuting, ClaimedAt: project.CreatedAt,
	}
	var task core.Task
	write := func(create bool, value *core.WorkerClaim) {
		t.Helper()
		if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
			values := TaskWrite{Title: "Attention", Status: core.TaskInProgress, Properties: core.TaskProperties{PullRequests: []core.PullRequestProperty{{URL: "\x00", Title: "Opaque"}}, Worker: value}}
			var err error
			if create {
				task, err = tx.CreateTask(ctx, queryID(10), values)
			} else {
				task, err = tx.UpdateTask(ctx, queryID(10), values)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	assertProjection := func(want bool) {
		t.Helper()
		if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			graph, err := snapshot.TaskGraphTasks(ctx, project.ID, task.ID, 160)
			if err != nil || len(graph) != 1 || graph[0].WorkerNeedsAttention != want {
				t.Fatalf("graph signaling projection: %#v %v", graph, err)
			}
			sync, err := snapshot.TaskSyncTasks(ctx, project.ID, &task.UpdatedAt, 160)
			if err != nil || len(sync) != 1 || sync[0].WorkerNeedsAttention != want {
				t.Fatalf("delta signaling projection: %#v %v", sync, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	worker.Signaling = "\x00 处理\n"
	write(true, worker)
	assertProjection(true)
	worker.Signaling = ""
	write(false, worker)
	assertProjection(false)
	worker.Signaling = " "
	write(false, worker)
	assertProjection(true)
	write(false, nil)
	assertProjection(false)
}
