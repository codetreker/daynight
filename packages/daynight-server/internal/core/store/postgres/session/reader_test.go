package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func readerWorker(t *testing.T, claim string) (model.WorkerClaim, string) {
	t.Helper()
	worker := model.WorkerClaim{
		ClaimID: claim, State: model.WorkerActive, UserID: queryID(901), WorkerID: queryID(902),
		Machine:  model.WorkerMachine{ID: queryID(903), Name: "Reader machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: queryID(904), Phase: model.WorkerExecuting, ClaimedAt: time.Date(2026, 11, 8, 1, 2, 3, 0, time.UTC),
	}
	value, err := taskproperties.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	return worker, string(value)
}

func readerSnapshot(t *testing.T, id, project, task string, worker model.WorkerClaim, lifecycle string) string {
	t.Helper()
	value, err := json.Marshal(sp.Snapshot{
		ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: worker.ClaimID, ExecutionGeneration: "7"}, ConnectionEpoch: "3"},
		Identity:        sp.Identity{ProjectID: project, TaskID: task, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, AgentControlMode: string(worker.AgentControlMode), ControllerID: queryID(905), Provider: "codex"},
		Lifecycle:       lifecycle,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(value)
}

func insertReaderSession(t *testing.T, db *postgres.Store, id, project, task string, worker model.WorkerClaim, snapshot string, lastSeen, drain *time.Time) {
	t.Helper()
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,last_seen,draining_until)
 VALUES($1,$2,$3,$4,$5,$1,'{}',$6::jsonb,$7,$8)`, id, project, task, worker.ClaimID, worker.UserID, snapshot, lastSeen, drain)
}

func readSessionSources(t *testing.T, db *postgres.Store, project string) []store.TaskSessionSource {
	t.Helper()
	var sources []store.TaskSessionSource
	if err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		var err error
		sources, err = scope.SessionDAO().CurrentTaskSessionSources(t.Context(), project)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return sources
}

func testSessionReaderCurrentProjectBindingsAndNarrowMetadata(t *testing.T, db *postgres.Store) {
	project, other := queryProject(t, db, 1), queryProject(t, db, 2)
	worker, raw := readerWorker(t, queryID(100))
	lastSeen := time.Date(2026, 11, 8, 1, 2, 4, 123456000, time.UTC)
	drain := lastSeen.Add(30 * time.Second)
	for _, number := range []int{11, 12, 13, 14, 15, 16, 17, 18, 19} {
		queryTask(t, db, project.ID, number, model.TaskInProgress)
	}
	queryTask(t, db, project.ID, 20, model.TaskTodo)
	queryTask(t, db, project.ID, 21, model.TaskDone)
	queryTask(t, db, other.ID, 22, model.TaskInProgress)
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, queryID(19))
	for _, number := range []int{12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22} {
		mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, queryID(number), raw)
	}
	for _, entry := range []struct {
		task, id  int
		lifecycle string
	}{{13, 113, "active"}, {14, 114, "draining"}, {15, 115, "archived"}, {19, 119, "active"}, {20, 120, "active"}, {21, 121, "active"}} {
		snapshot := readerSnapshot(t, queryID(entry.id), project.ID, queryID(entry.task), worker, entry.lifecycle)
		var seen, deadline *time.Time
		if entry.task == 14 {
			seen, deadline = &lastSeen, &drain
		}
		insertReaderSession(t, db, queryID(entry.id), project.ID, queryID(entry.task), worker, snapshot, seen, deadline)
	}
	insertReaderSession(t, db, queryID(122), other.ID, queryID(22), worker, readerSnapshot(t, queryID(122), other.ID, queryID(22), worker, "active"), nil, nil)
	stale := worker
	stale.ClaimID = queryID(101)
	insertReaderSession(t, db, queryID(116), project.ID, queryID(16), stale, readerSnapshot(t, queryID(116), project.ID, queryID(16), stale, "active"), nil, nil)
	insertReaderSession(t, db, queryID(117), other.ID, queryID(17), worker, readerSnapshot(t, queryID(117), other.ID, queryID(17), worker, "active"), nil, nil)
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,backend,snapshot,terminal_state)
 VALUES($1,$2,$3,$4,$5,$1,'{}','herdr',NULL,'{}')`, queryID(118), project.ID, queryID(18), worker.ClaimID, worker.UserID)
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id)
 VALUES($1,$2,$1,'{}','{}','test',$3)`, queryID(123), worker.UserID, queryID(124))

	sources := readSessionSources(t, db, project.ID)
	if len(sources) != 8 {
		t.Fatalf("current project tasks: got %d, want 8", len(sources))
	}
	for i, source := range sources {
		if source.TaskID != queryID(11+i) || source.TaskStatus != model.TaskInProgress {
			t.Fatalf("task ordering/filter: %#v", source)
		}
		if i == 0 {
			if source.Worker != nil || source.Session != nil {
				t.Fatalf("missing worker was synthesized: %#v", source)
			}
			continue
		}
		if !reflect.DeepEqual(source.Worker, &worker) {
			t.Fatalf("worker changed: got %#v, want %#v", source.Worker, worker)
		}
		if i < 2 || i > 4 {
			if source.Session != nil {
				t.Fatalf("missing/current-claim/project/backend join accepted another session: %#v", source)
			}
			continue
		}
		state := source.Session
		wantLifecycle := []string{"active", "draining", "archived"}[i-2]
		if state == nil || state.SessionID != queryID(111+i) || state.ProjectID != project.ID || state.TaskID != source.TaskID || state.ClaimID != worker.ClaimID ||
			state.Fence.SessionID != state.SessionID || state.Fence.ClaimID != worker.ClaimID || state.Fence.ExecutionGeneration != "7" || state.Fence.ConnectionEpoch != "3" ||
			state.Identity != (sp.Identity{ProjectID: project.ID, TaskID: source.TaskID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, AgentControlMode: "web", ControllerID: queryID(905), Provider: "codex"}) || state.Lifecycle != wantLifecycle {
			t.Fatalf("narrow durable state changed: %#v", state)
		}
		if i == 3 {
			if state.LastSeen == nil || !state.LastSeen.Equal(lastSeen) || state.DrainUntil == nil || !state.DrainUntil.Equal(drain) {
				t.Fatalf("DB timestamps lost: %#v", state)
			}
		} else if state.LastSeen != nil || state.DrainUntil != nil {
			t.Fatalf("NULL timestamps synthesized: %#v", state)
		}
	}
	if empty := readSessionSources(t, db, queryID(999)); empty == nil || len(empty) != 0 {
		t.Fatalf("empty source snapshot: %#v", empty)
	}
}

func testSessionReaderPropagatesWorkerDecodeErrors(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 11, model.TaskInProgress)
	_, valid := readerWorker(t, queryID(100))
	for _, test := range []struct {
		name, raw, sqlState string
	}{
		{name: "invalid JSON", raw: "{", sqlState: "22P02"},
		{name: "worker field type", raw: strings.Replace(valid, `"state":"active"`, `"state":1`, 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2) ON CONFLICT(task_id,name) DO UPDATE SET value=excluded.value`, task.ID, test.raw)
			err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
				_, err := scope.SessionDAO().CurrentTaskSessionSources(t.Context(), project.ID)
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("corrupt worker accepted or hidden: %v", err)
			}
			if test.sqlState != "" {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) || driver.Code != test.sqlState {
					t.Fatalf("SQL decode cause lost: %v", err)
				}
			}
			if test.sqlState == "" {
				var decoding *json.UnmarshalTypeError
				if !errors.As(err, &decoding) {
					t.Fatalf("worker decoding cause lost: %v", err)
				}
			}
		})
	}
}

func testSessionReaderPreservesMetadataDecodeErrorsAndIndependentIdentity(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 11, model.TaskInProgress)
	worker, raw := readerWorker(t, queryID(100))
	id := queryID(111)
	valid := readerSnapshot(t, id, project.ID, task.ID, worker, "active")
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, raw)
	insertReaderSession(t, db, id, project.ID, task.ID, worker, valid, nil, nil)
	for _, test := range []struct{ name, path, value string }{
		{"generation numeric", "{executionGeneration}", `7`}, {"epoch numeric", "{connectionEpoch}", `3`},
		{"task identity numeric", "{identity,taskId}", `1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set($2::jsonb,$3::text[],$4::jsonb) WHERE id=$1`, id, valid, test.path, test.value)
			err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
				_, err := scope.SessionDAO().CurrentTaskSessionSources(t.Context(), project.ID)
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("corrupt metadata accepted or hidden: %v", err)
			}
			var failure *store.Error
			var decoding *json.UnmarshalTypeError
			if !errors.As(err, &failure) || !errors.As(err, &decoding) {
				t.Fatalf("metadata decoding cause lost: %v", err)
			}
		})
	}
	// A valid but different snapshot identity must remain visible to the business
	// projection, which compares it with the independent durable row binding.
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set($2::jsonb,'{identity,taskId}',to_jsonb($3::text)) WHERE id=$1`, id, valid, queryID(999))
	sources := readSessionSources(t, db, project.ID)
	if len(sources) != 1 || sources[0].Session.TaskID != task.ID || sources[0].Session.Identity.TaskID != queryID(999) {
		t.Fatalf("independent identity evidence collapsed: %#v", sources)
	}
}

type countedReaderTx struct {
	pgx.Tx
	queries, fields int
}

func (tx *countedReaderTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.queries++
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err == nil {
		tx.fields = len(rows.FieldDescriptions())
	}
	return rows, err
}

func testSessionReaderUsesOneReadOnlyProjectQuery(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	worker, raw := readerWorker(t, queryID(100))
	for _, number := range []int{11, 12, 13} {
		queryTask(t, db, project.ID, number, model.TaskInProgress)
		mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, queryID(number), raw)
		insertReaderSession(t, db, queryID(number+100), project.ID, queryID(number), worker, readerSnapshot(t, queryID(number+100), project.ID, queryID(number), worker, "active"), nil, nil)
	}
	if err := postgres.ReadOnlySnapshot(t.Context(), db.Pool, func(tx pgx.Tx) error {
		var readOnly, isolation string
		if err := tx.QueryRow(t.Context(), `SELECT current_setting('transaction_read_only'),current_setting('transaction_isolation')`).Scan(&readOnly, &isolation); err != nil {
			return err
		}
		if readOnly != "on" || isolation != "repeatable read" {
			t.Fatalf("snapshot transaction settings: %q %q", readOnly, isolation)
		}
		counted := &countedReaderTx{Tx: tx}
		sources, err := pgsession.NewReader(counted).CurrentTaskSessionSources(t.Context(), project.ID)
		if err != nil {
			return err
		}
		if len(sources) != 3 || counted.queries != 1 || counted.fields != 10 {
			t.Fatalf("project query is not narrow and batched: rows=%d queries=%d columns=%d", len(sources), counted.queries, counted.fields)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
