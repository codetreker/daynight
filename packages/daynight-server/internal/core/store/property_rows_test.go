package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5/pgconn"
)

func legacyWorker026Fixture() map[string]any {
	return map[string]any{
		"claimId": queryID(201), "state": "active", "userId": queryID(202), "workerId": queryID(203),
		"machine": map[string]any{"id": queryID(204), "name": "Machine"}, "platform": "linux", "agent": "codex",
		"agentControlMode": "herdr", "worktreeId": queryID(205), "phase": "executing",
		"herdr":           map[string]any{"session": "session", "workspaceId": "workspace", "paneId": "pane"},
		"nativeSessionId": "native", "claimedAt": "2026-10-24T01:02:03.123456Z",
	}
}

func legacyProperties026Fixture(t *testing.T, worker any) string {
	t.Helper()
	value, err := json.Marshal(map[string]any{"pullRequests": []any{map[string]any{"url": "\x00", "title": "Unicode 中文"}, map[string]any{"url": "same", "title": "duplicate"}, map[string]any{"url": "same", "title": "duplicate"}}, "worker": worker})
	if err != nil {
		t.Fatal(err)
	}
	return string(value)
}

func TestPropertyRowsMigrationPreservesValuesAndTaskFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	expected := make(map[string]core.TaskProperties)
	for i := 0; i < 105; i++ {
		var worker any
		if i%4 != 0 {
			w := legacyWorker026Fixture()
			w["state"] = []string{"active", "released", "completed"}[i%3]
			if i%5 == 0 {
				delete(w, "agentControlMode")
			}
			worker = w
		}
		raw := legacyProperties026Fixture(t, worker)
		if i == 0 {
			raw = `{"pullRequests":[],"worker":null}`
		}
		if i == 1 {
			raw = `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}`
		}
		id := queryID(i + 10)
		var deleted any
		if i%7 == 0 {
			deleted = stamp.Add(time.Hour)
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,deleted_at,properties) VALUES($1,$2,'Migration','Body','todo',9007199254740993,$3,$4,$5,$6)`, id, project.ID, stamp, stamp.Add(time.Hour), deleted, raw)
		values, err := decodeLegacyPropertyRows026([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		expected[id] = core.TaskProperties(values)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'properties' ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&after); err != nil || before != after {
		t.Fatalf("parent task facts changed: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		ids := make([]string, 0, len(expected))
		for id := range expected {
			ids = append(ids, id)
		}
		actual, err := loadTaskProperties(ctx, snapshot.tx, ids)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("migration changed property values: %#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var oldColumn bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&oldColumn); err != nil || oldColumn {
		t.Fatalf("old column retained: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	changed := append([]migration(nil), schemaMigrations...)
	changed[len(changed)-1].transformSource += "changed"
	if err := migrate(ctx, pool, changed); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("transform source is not checksummed: %v", err)
	}
}

func TestPropertyRowsMigrationRejectsInvalidInputAtomically(t *testing.T) {
	for _, bad := range []string{`{"pullRequests":[],"worker":null,"unknown":0}`, `{"pullRequests":null,"worker":null}`, `{"pullRequests":[],"worker":null,"worker":null}`, `{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`} {
		t.Run(bad, func(t *testing.T) {
			ctx := context.Background()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
				t.Fatal(err)
			}
			database := &Store{Pool: pool}
			project := queryProject(t, database, 1)
			mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,properties) VALUES($1,$2,'Good','{"pullRequests":[],"worker":null}'),($3,$2,'Bad',$4)`, queryID(10), project.ID, queryID(20), bad)
			if err := migrate(ctx, pool, schemaMigrations); err == nil {
				t.Fatal("invalid legacy value migrated")
			}
			var table, oldColumn bool
			var count int
			if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='task_properties'),EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&table, &oldColumn); err != nil || table || !oldColumn {
				t.Fatalf("partial schema retained: %v", err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=26`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("failed migration ledger retained: %v", err)
			}
		})
	}
}

func TestPropertyRowsMigrationLedgerFailureRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Ledger')`, queryID(10), project.ID)
	mustQueryExec(t, database, `CREATE FUNCTION refuse_property_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=26 THEN RAISE EXCEPTION USING ERRCODE='P1026', MESSAGE='ledger refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_property_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION refuse_property_ledger()`)
	err := migrate(ctx, pool, schemaMigrations)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "P1026" {
		t.Fatalf("ledger cause lost: %v", err)
	}
	var raw string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(10)).Scan(&raw); err != nil || raw != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("legacy task changed: %v", err)
	}
	mustQueryExec(t, database, `DROP TRIGGER refuse_property_ledger ON schema_migrations; DROP FUNCTION refuse_property_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestPropertyRowsWritesAreAtomicWithTaskMetadata(t *testing.T) {
	ctx := context.Background()
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, core.TaskTodo)
	properties := core.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque","title":"PR"}]`)}
	for _, table := range []string{"tasks", "task_properties"} {
		mustQueryExec(t, database, `CREATE FUNCTION refuse_property_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'property transaction refusal'; END $$; CREATE TRIGGER refuse_property_write BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_property_write()`)
		err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
			_, err := tx.UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: core.TaskTodo, Properties: properties})
			return err
		})
		if err == nil {
			t.Fatal("failed write succeeded")
		}
		actual := snapshotTask(t, database, project.ID, task.ID)
		if !reflect.DeepEqual(actual, task) {
			t.Fatalf("partial task/property commit: %#v", actual)
		}
		mustQueryExec(t, database, `DROP TRIGGER refuse_property_write ON `+table+`; DROP FUNCTION refuse_property_write()`)
	}
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		_, err := tx.UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: core.TaskTodo, Properties: properties})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	actual := snapshotTask(t, database, project.ID, task.ID)
	if actual.Version != task.Version+1 || len(actual.Properties) != 1 {
		t.Fatalf("successful property write missing: %#v", actual)
	}
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		_, err := tx.UpdateTask(ctx, task.ID, TaskWrite{Title: actual.Title, Status: actual.Status, Properties: core.TaskProperties{}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if actual = snapshotTask(t, database, project.ID, task.ID); len(actual.Properties) != 0 {
		t.Fatalf("property deletion left a default: %#v", actual.Properties)
	}
}

func TestPropertyRowsInvalidStoredValuePreservesValidationError(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, core.TaskTodo)
	for _, value := range []struct{ name, raw string }{{"unknown", "[]"}, {"pullRequests", "null"}, {"worker", "{}"}} {
		mustQueryExec(t, database, `DELETE FROM task_properties WHERE task_id=$1`, task.ID)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, task.ID, value.name, value.raw)
		err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			_, err := snapshot.Task(context.Background(), project.ID, task.ID)
			return err
		})
		var validation *taskproperties.ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("invalid stored property lost validation type: %v", err)
		}
	}
}

func legacyWorkerJSON026(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(legacyWorker026Fixture())
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]json.RawMessage
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func legacyWorkerPropertiesJSON026(t *testing.T, worker map[string]json.RawMessage) []byte {
	t.Helper()
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	return append(append([]byte(`{"pullRequests":[],"worker":`), raw...), '}')
}
func TestLegacyPropertyRows026RequiresCompleteStrictWorker(t *testing.T) {
	for _, field := range []string{"claimId", "state", "userId", "workerId", "machine", "platform", "agent", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"} {
		t.Run("missing "+field, func(t *testing.T) {
			worker := legacyWorkerJSON026(t)
			delete(worker, field)
			if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
				t.Fatalf("missing worker.%s was accepted", field)
			}
		})
	}
	for _, test := range []struct{ name, key, value string }{
		{"claim uuid", "claimId", `"invalid"`}, {"user uuid", "userId", `"invalid"`}, {"worker uuid", "workerId", `"invalid"`}, {"worktree uuid", "worktreeId", `"invalid"`},
		{"state", "state", `"idle"`}, {"platform", "platform", `"darwin"`}, {"agent", "agent", `"other"`}, {"phase", "phase", `"done"`},
		{"state null", "state", `null`}, {"worker numeric", "workerId", `123`}, {"claimed timestamp", "claimedAt", `"not-time"`}, {"zero timestamp", "claimedAt", `"0001-01-01T00:00:00Z"`},
		{"machine scalar", "machine", `3`}, {"machine missing id", "machine", `{"name":"build"}`}, {"machine missing name", "machine", `{"id":"00000000-0000-4000-8000-000000000004"}`},
		{"machine wrong id", "machine", `{"id":"wrong","name":"build"}`}, {"machine blank name", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":" \n"}`},
		{"machine NUL name", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build\u0000"}`},
		{"machine unknown", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build","extra":true}`},
		{"machine duplicate", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build","name":"other"}`},
		{"herdr scalar", "herdr", `false`}, {"herdr missing", "herdr", `{"session":"w","workspaceId":"workspace"}`}, {"herdr wrong type", "herdr", `{"session":"w","workspaceId":null,"paneId":"pane"}`},
		{"herdr blank", "herdr", `{"session":" ","workspaceId":"workspace","paneId":"pane"}`}, {"herdr NUL", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane\u0000"}`},
		{"herdr unknown", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane","extra":true}`}, {"herdr duplicate", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane","paneId":"other"}`},
		{"native numeric", "nativeSessionId", `0`}, {"native blank", "nativeSessionId", `" "`}, {"native NUL", "nativeSessionId", `"session\u0000"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			worker := legacyWorkerJSON026(t)
			worker[test.key] = json.RawMessage(test.value)
			data, err := json.Marshal(worker)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeLegacyPropertyRows026(append(append([]byte(`{"pullRequests":[],"worker":`), data...), '}')); err == nil {
				t.Fatalf("invalid worker field was accepted: %s", data)
			}
		})
	}
	worker := legacyWorkerJSON026(t)
	worker["extra"] = json.RawMessage(`true`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
		t.Fatal("unknown worker field was accepted")
	}
	valid := string(legacyWorkerPropertiesJSON026(t, legacyWorkerJSON026(t)))
	duplicate := strings.Replace(valid, `"worker":{`, `"worker":null,"worker":{`, 1)
	if _, err := decodeLegacyPropertyRows026([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker property was accepted")
	}
	duplicate = strings.Replace(valid, `"claimId":`, `"claimId":"00000000-0000-4000-8000-000000000001","claimId":`, 1)
	if _, err := decodeLegacyPropertyRows026([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker identity was accepted")
	}
	for _, data := range []string{`{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`, `{"pullRequests":[],"worker":[]}`, `{"pullRequests":[],"worker":true}`} {
		if _, err := decodeLegacyPropertyRows026([]byte(data)); err == nil {
			t.Fatalf("invalid nullable worker read field accepted: %s", data)
		}
	}
}

func TestLegacyPropertyRows026NormalizesOnlySupportedValues(t *testing.T) {
	for _, raw := range []string{`[]`, `null`, `{"pullRequests":[]}false`, `{"pullRequests":[{}],"worker":null}`, `{"pullRequests":[{"url":"x","title":null}],"worker":null}`, `{"pullRequests":[{"url":"x","url":"y","title":""}],"worker":null}`} {
		if _, err := decodeLegacyPropertyRows026([]byte(raw)); err == nil {
			t.Fatalf("invalid legacy document accepted: %s", raw)
		}
	}
	for _, test := range []struct{ key, raw string }{{"agentControlMode", `"invalid"`}, {"agentControlMode", `null`}, {"claimId", `"00000000-0000-4000-8000-00000000000z"`}} {
		worker := legacyWorkerJSON026(t)
		worker[test.key] = json.RawMessage(test.raw)
		if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
			t.Fatal("invalid legacy worker mode or identifier accepted")
		}
	}
	worker := legacyWorkerJSON026(t)
	worker["agentControlMode"] = json.RawMessage(`"web"`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
		t.Fatal("legacy web worker with Herdr accepted")
	}
	worker["herdr"] = json.RawMessage(`null`)
	worker["nativeSessionId"] = json.RawMessage(`null`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err != nil {
		t.Fatal(err)
	}
	if m026encodeWorker(nil) != nil {
		t.Fatal("nil legacy worker encoded as a record")
	}
}
