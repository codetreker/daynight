package store

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestWorkerModeMigrationPreservesLegacyHistoryAndNullWorkers(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:19]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	worker := `{"claimId":"00000000-0000-4000-8000-000000000001","state":"active","userId":"00000000-0000-4000-8000-000000000002","workerId":"00000000-0000-4000-8000-000000000003","machine":{"id":"00000000-0000-4000-8000-000000000004","name":"Build"},"platform":"linux","agent":"codex","worktreeId":"00000000-0000-4000-8000-000000000005","phase":"executing","herdr":null,"nativeSessionId":"native","claimedAt":"2026-10-24T01:02:03Z"}`
	// PostgreSQL jsonb cannot represent these opaque PR strings; the migration
	// must preserve their JSON bytes without decoding them as PostgreSQL text.
	prs := `[{"url":"\u0000","title":"\ud800"},{"url":"https://example.com/worker","title":"worker and agentControlMode are ordinary text"}]`
	inputs := []string{
		`{"pullRequests":` + prs + `,"worker":` + worker + `}`,
		`{"pullRequests":` + prs + `,"worker":null}`,
		`{"pullRequests":[],"worker":` + strings.Replace(worker, `"state":"active"`, `"state":"released"`, 1) + `}`,
	}
	for i, properties := range inputs {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,version,properties) VALUES($1,$2,'Mode migration',$3,9007199254740993,$4)`, queryID(10+i), project.ID, []string{"in_progress", "todo", "todo"}[i], properties)
	}
	before := workerMigrationRows(t, database)
	for range 2 {
		if err := migrate(ctx, pool, schemaMigrations[:20]); err != nil {
			t.Fatal(err)
		}
		after := workerMigrationRows(t, database)
		for i, row := range after {
			if row.OtherFacts != before[i].OtherFacts || row.ID != before[i].ID {
				t.Fatal("mode migration changed task identity, version, timestamps or status")
			}
			if i == 1 {
				if row.Properties != inputs[i] {
					t.Fatal("null worker properties were rewritten")
				}
				continue
			}
			var original, updated map[string]json.RawMessage
			if err := json.Unmarshal([]byte(inputs[i]), &original); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(row.Properties), &updated); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(original["pullRequests"], updated["pullRequests"]) {
				t.Fatal("mode migration rewrote opaque PR JSON")
			}
			var execution map[string]json.RawMessage
			if err := json.Unmarshal(updated["worker"], &execution); err != nil {
				t.Fatal(err)
			}
			if string(execution["agentControlMode"]) != `"herdr"` {
				t.Fatalf("legacy execution did not persist herdr: %s", updated["worker"])
			}
			if _, err := decodeHistoricalPropertiesFixture([]byte(row.Properties)); err != nil {
				t.Fatalf("migrated history is unreadable: %v", err)
			}
		}
	}
}
