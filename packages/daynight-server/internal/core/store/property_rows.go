package store

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5"
)

func loadTaskProperties(ctx context.Context, tx pgx.Tx, taskIDs []string) (map[string]core.TaskProperties, error) {
	result := make(map[string]core.TaskProperties, len(taskIDs))
	for _, id := range taskIDs {
		result[id] = core.TaskProperties{}
	}
	if len(taskIDs) == 0 {
		return result, nil
	}
	rows, err := tx.Query(ctx, `SELECT task_id::text,name,value FROM task_properties WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,name`, taskIDs)
	if err != nil {
		return nil, queryError("read task properties", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, raw string
		if err := rows.Scan(&id, &name, &raw); err != nil {
			return nil, queryError("read task properties", err)
		}
		value, err := taskproperties.NormalizeValue(name, json.RawMessage(raw), false)
		if err != nil {
			return nil, queryError("decode task property", err)
		}
		result[id][name] = value
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read task properties", err)
	}
	return result, nil
}

func attachTaskProperties(ctx context.Context, tx pgx.Tx, tasks []core.Task) error {
	ids := make([]string, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID
	}
	properties, err := loadTaskProperties(ctx, tx, ids)
	if err != nil {
		return err
	}
	for i := range tasks {
		tasks[i].Properties = properties[tasks[i].ID]
	}
	return nil
}

func writeTaskProperties(ctx context.Context, tx pgx.Tx, taskID string, properties core.TaskProperties) error {
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	slices.Sort(names)
	if _, err := tx.Exec(ctx, `DELETE FROM task_properties WHERE task_id=$1 AND NOT (name=ANY($2::text[]))`, taskID, names); err != nil {
		return queryError("remove task properties", err)
	}
	for _, name := range names {
		if _, err := tx.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3) ON CONFLICT(task_id,name) DO UPDATE SET value=EXCLUDED.value WHERE task_properties.value IS DISTINCT FROM EXCLUDED.value`, taskID, name, string(properties[name])); err != nil {
			return queryError("write task property", err)
		}
	}
	return nil
}
