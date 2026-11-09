package testutil

import (
	"context"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

var StepWitnessIDs = []string{"00000000", "11111111", "abcdef01", "fedcba98"}

func SeedStep(t *testing.T, pool *pgxpool.Pool, taskID, id string, position int64) {
	t.Helper()
	MustExec(t, pool, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,'Coding','## Result','done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z')`, taskID, id, position)
}

func SeedStepWitnessRows(t *testing.T, pool *pgxpool.Pool, taskID string, count int) {
	t.Helper()
	for index, id := range StepWitnessIDs[:count] {
		MustExec(t, pool, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,'same',$4,$5,'2026-01-02T03:04:05.123456Z'::timestamptz+$3::bigint*interval '1 day',
 '2026-02-03T04:05:06.654321Z'::timestamptz+$3::bigint*interval '1 day')`,
			taskID, id, index, "  # "+id+"\n<原值&>  ", []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index])
	}
}

func StepWitnessState(t *testing.T, pool *pgxpool.Pool, taskID string, parentOnly bool) string {
	t.Helper()
	var state string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
 'task',(SELECT CASE WHEN $2 THEN to_jsonb(t)-'version'-'updated_at' ELSE to_jsonb(t) END FROM tasks t WHERE id=$1),
 'steps',CASE WHEN $2 THEN NULL ELSE (SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=$1) END,
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, taskID, parentOnly).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func MutateStep(ctx context.Context, dao store.TaskWriteDAO, taskID, operation string) error {
	rows, err := dao.TaskSteps(ctx, taskID)
	if err != nil {
		return err
	}
	stamp, err := dao.ObservedAt(ctx)
	if err != nil {
		return err
	}
	switch operation {
	case "add":
		err = dao.InsertTaskStep(ctx, taskID, model.TaskStep{ID: "12345678", Position: 0, Title: "new", Description: "new body", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
	case "change", "status":
		target := rows[0]
		if operation == "change" {
			target.Title, target.Description = "new title", "new description"
		} else {
			target.Status = model.TaskStepDone
		}
		target.UpdatedAt = stamp
		err = dao.UpdateTaskStep(ctx, taskID, target)
	case "delete":
		err = dao.DeleteTaskStep(ctx, taskID, rows[0].ID, 0, int64(len(rows)-1))
	case "move":
		err = dao.MoveTaskStep(ctx, taskID, rows[0].ID, 0, int64(len(rows)-1))
	default:
		return fmt.Errorf("unknown step witness operation %q", operation)
	}
	if err != nil {
		return err
	}
	return dao.TouchTask(ctx, taskID, stamp)
}
