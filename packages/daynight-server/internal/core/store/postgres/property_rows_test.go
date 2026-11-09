package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
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
	expected := make(map[string]map[string]any)
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
		var values map[string]any
		if err := json.Unmarshal([]byte(raw), &values); err != nil {
			t.Fatal(err)
		}
		if values["worker"] == nil {
			delete(values, "worker")
		} else if worker := values["worker"].(map[string]any); worker["agentControlMode"] == nil {
			worker["agentControlMode"] = "herdr"
		}
		expected[id] = values
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'properties' ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:26]); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&after); err != nil || before != after {
		t.Fatalf("parent task facts changed: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		ids := make([]string, 0, len(expected))
		for id := range expected {
			ids = append(ids, id)
		}
		actual, err := pg.LoadTaskProperties(ctx, snapshot.(*Snapshot).tx, ids)
		if err != nil {
			return err
		}
		for id, properties := range actual {
			values := make(map[string]any, len(properties))
			for key, raw := range properties {
				var value any
				if err := json.Unmarshal(raw, &value); err != nil {
					return err
				}
				values[key] = value
			}
			if !reflect.DeepEqual(values, expected[id]) {
				t.Fatalf("migration changed property values for %s: %#v", id, values)
			}
		}
		if len(actual) != len(expected) {
			t.Fatalf("migration lost tasks: got %d, want %d", len(actual), len(expected))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var oldColumn bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&oldColumn); err != nil || oldColumn {
		t.Fatalf("old column retained: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:26]); err != nil {
		t.Fatal(err)
	}
	changed := append([]migration(nil), schemaMigrations[:26]...)
	changed[25].transformSource += "changed"
	if err := migrate(ctx, pool, changed); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("transform source is not checksummed: %v", err)
	}
}

func TestPropertyRowsMigrationRejectsInvalidInputAtomically(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	const good = `{"pullRequests":[],"worker":null}`
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,properties) VALUES($1,$2,'Good',$4),($3,$2,'Bad',$4)`, queryID(10), project.ID, queryID(20), good)
	source := func(t *testing.T) string {
		t.Helper()
		var facts string
		if err := pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t").Scan(&facts); err != nil {
			t.Fatal(err)
		}
		return facts
	}
	ledger := func(t *testing.T) string {
		t.Helper()
		var facts string
		if err := pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m").Scan(&facts); err != nil {
			t.Fatal(err)
		}
		return facts
	}
	original, originalLedger := source(t), ledger(t)
	for _, bad := range []string{`{"pullRequests":[],"worker":null,"unknown":0}`, `{"pullRequests":null,"worker":null}`, `{"pullRequests":[],"worker":null,"worker":null}`, `{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`} {
		if !t.Run(bad, func(t *testing.T) {
			if original != source(t) || originalLedger != ledger(t) {
				t.Fatal("previous failure changed the historical property fixture")
			}
			mustQueryExec(t, database, "UPDATE tasks SET properties=$2 WHERE id=$1", queryID(20), bad)
			var stored string
			if err := pool.QueryRow(t.Context(), "SELECT properties FROM tasks WHERE id=$1", queryID(20)).Scan(&stored); err != nil || stored != bad {
				t.Fatalf("invalid legacy input bytes changed: %q %v", stored, err)
			}
			before := source(t)
			migrations := append([]migration(nil), schemaMigrations...)
			if err := migrate(ctx, pool, migrations); err == nil {
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
			if before != source(t) || originalLedger != ledger(t) {
				t.Fatal("failed property migration changed original source rows or ledger")
			}
			assertMigrationPoolReusable(t, pool)
			mustQueryExec(t, database, "UPDATE tasks SET properties=$2 WHERE id=$1", queryID(20), good)
			if original != source(t) || originalLedger != ledger(t) {
				t.Fatal("historical property fixture was not restored exactly")
			}
		}) {
			return
		}
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
	task := queryTask(t, database, project.ID, 2, model.TaskTodo)
	properties := model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque","title":"PR"}]`)}
	for _, table := range []string{"tasks", "task_properties"} {
		mustQueryExec(t, database, `CREATE FUNCTION refuse_property_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'property transaction refusal'; END $$; CREATE TRIGGER refuse_property_write BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_property_write()`)
		err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: model.TaskTodo, Properties: properties})
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
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: model.TaskTodo, Properties: properties})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	actual := snapshotTask(t, database, project.ID, task.ID)
	if actual.Version != task.Version+1 || len(actual.Properties) != 1 {
		t.Fatalf("successful property write missing: %#v", actual)
	}
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: actual.Title, Status: actual.Status, Properties: model.TaskProperties{}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if actual = snapshotTask(t, database, project.ID, task.ID); len(actual.Properties) != 0 {
		t.Fatalf("property deletion left a default: %#v", actual.Properties)
	}
}
