package testutil

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TaskProperties(t *testing.T, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	properties, err := taskprops.WithWorker(model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}, worker)
	if err != nil {
		t.Fatal(err)
	}
	return properties
}

func PullRequests(t *testing.T, properties model.TaskProperties) []model.PullRequestProperty {
	t.Helper()
	values, err := taskproperties.PullRequests(properties)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func Worker(t *testing.T, properties model.TaskProperties) *model.WorkerClaim {
	t.Helper()
	value, err := taskproperties.Worker(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func PutTaskProperty(t *testing.T, pool *pgxpool.Pool, taskID, name string, value []byte) {
	t.Helper()
	MustExec(t, pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)
 ON CONFLICT(task_id,name) DO UPDATE SET value=EXCLUDED.value`, taskID, name, string(value))
}

func CurrentTaskFacts(t *testing.T, pool *pgxpool.Pool) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	rows, err := pool.Query(context.Background(), `SELECT id::text,to_jsonb(t)::text FROM tasks t ORDER BY id`)
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
	rows, err = pool.Query(context.Background(), `SELECT task_id::text,name,value FROM task_properties ORDER BY task_id,name`)
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
