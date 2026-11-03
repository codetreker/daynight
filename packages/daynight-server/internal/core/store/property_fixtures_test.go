package store

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func fixtureTaskProperties(t *testing.T, worker *core.WorkerClaim) core.TaskProperties {
	t.Helper()
	properties, err := taskproperties.WithWorker(core.TaskProperties{"pullRequests": json.RawMessage(`[]`)}, worker)
	if err != nil {
		t.Fatal(err)
	}
	return properties
}

func fixturePullRequests(t *testing.T, properties core.TaskProperties) []core.PullRequestProperty {
	t.Helper()
	values, err := taskproperties.PullRequests(properties)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func fixtureWorker(t *testing.T, properties core.TaskProperties) *core.WorkerClaim {
	t.Helper()
	value, err := taskproperties.Worker(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func putTaskPropertyFixture(t *testing.T, database *Store, taskID, name string, value []byte) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)
 ON CONFLICT(task_id,name) DO UPDATE SET value=EXCLUDED.value`, taskID, name, string(value)); err != nil {
		t.Fatal(err)
	}
}

// Historical assertions normalize only the schema they own; runtime readers
// accept neither a legacy column nor an explicit null execution property.
func decodeHistoricalPropertiesFixture(data []byte) (core.TaskProperties, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(fields["worker"]), []byte("null")) {
		delete(fields, "worker")
	}
	normalized, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	return taskproperties.Decode(normalized)
}

func currentTaskFactsFixture(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	rows, err := database.Pool.Query(context.Background(), `SELECT id::text,to_jsonb(t)::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, value string
		if err := rows.Scan(&id, &value); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		facts["task:"+id] = value
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows, err = database.Pool.Query(context.Background(), `SELECT task_id::text,name,value FROM task_properties ORDER BY task_id,name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, value string
		if err := rows.Scan(&id, &name, &value); err != nil {
			t.Fatal(err)
		}
		facts["property:"+id+":"+name] = value
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return facts
}
