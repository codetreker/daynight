package task

import (
	"context"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type Writer struct {
	tx        pgx.Tx
	projectID string
}

func NewWriter(tx pgx.Tx, projectID string) TaskWriteDAO {
	return &Writer{tx: tx, projectID: projectID}
}

var _ TaskWriteDAO = (*Writer)(nil)

func (tx *Writer) Task(ctx context.Context, id string) (model.Task, error) {
	return pg.ReadTaskWithLock(ctx, tx.tx, tx.projectID, id, " FOR UPDATE OF t")
}

func (tx *Writer) ParentTask(ctx context.Context, id string) (model.Task, error) {
	return pg.ReadTaskWithLock(ctx, tx.tx, tx.projectID, id, "")
}

func (tx *Writer) GoalProgresses(ctx context.Context, projectID string, ids []string) (map[string]model.GoalProgress, error) {
	return (&Reader{tx: tx.tx}).GoalProgresses(ctx, projectID, ids)
}

func (tx *Writer) TasksByID(ctx context.Context, ids []string) ([]model.Task, error) {
	return tx.tasks(ctx, `t.id = ANY($2::uuid[])`, ids, "read prerequisites")
}

// VisibleTaskIDs admits only live ordinary resources as new dependency targets.
func (tx *Writer) VisibleTaskIDs(ctx context.Context, ids []string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT id::text FROM task_resource_rows
		WHERE project_id=$1 AND id=ANY($2::uuid[]) AND type='task' AND effective_deleted_at IS NULL ORDER BY id`, tx.projectID, ids)
	if err != nil {
		return nil, pg.QueryError("read visible dependency targets", err)
	}
	defer rows.Close()
	visible, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pg.QueryError("read visible dependency targets", err)
	}
	return visible, nil
}

func (tx *Writer) tasks(ctx context.Context, condition string, value any, phase string) ([]model.Task, error) {
	rows, err := tx.tx.Query(ctx, `SELECT `+pg.TaskProjection+` FROM tasks t
		WHERE t.project_id = $1 AND t.deleted_at IS NULL AND t.type = 'task' AND `+condition+` ORDER BY t.id`, tx.projectID, value)
	if err != nil {
		return nil, pg.QueryError(phase, err)
	}
	tasks, err := pg.CollectTasks(rows)
	if err != nil {
		return nil, pg.QueryError(phase, err)
	}
	if err := pg.AttachTaskProperties(ctx, tx.tx, tasks); err != nil {
		return nil, err
	}
	if err := pg.AttachTaskTags(ctx, tx.tx, tx.projectID, tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}

func (tx *Writer) ActiveDependentIDs(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT t.id::text FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND d.depends_on_task_id = $2
		AND t.deleted_at IS NULL AND t.type = 'task' AND t.status IN ('in_progress', 'done') ORDER BY t.id`, tx.projectID, id)
	if err != nil {
		return nil, pg.QueryError("read active dependents", err)
	}
	defer rows.Close()
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pg.QueryError("read active dependents", err)
	}
	return ids, nil
}

func (tx *Writer) Reachable(ctx context.Context, from, to string, replacement DependencyReplacement) (bool, error) {
	var reachable bool
	err := tx.tx.QueryRow(ctx, `WITH RECURSIVE edges(task_id, depends_on_task_id) AS (
		SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND t.deleted_at IS NULL AND t.type = 'task' AND d.task_id <> $4::uuid
		UNION SELECT $4::uuid, unnest($5::uuid[])
	), visited(id) AS (
		SELECT $2::uuid
		UNION SELECT e.depends_on_task_id FROM edges e JOIN visited v ON e.task_id = v.id
	) SELECT EXISTS(SELECT 1 FROM visited WHERE id = $3::uuid)`,
		tx.projectID, from, to, replacement.TaskID, replacement.DependsOn).Scan(&reachable)
	if err != nil {
		return false, pg.QueryError("candidate reachability", err)
	}
	return reachable, nil
}

func (tx *Writer) CreateTask(ctx context.Context, id string, values TaskWrite) (model.Task, error) {
	properties, err := taskproperties.Normalize(values.Properties)
	if err != nil {
		return model.Task{}, pg.QueryError("validate task properties", err)
	}
	values.Properties = properties
	taskType := values.Type
	if taskType == "" {
		taskType = model.TaskTypeTask
	}
	var observedAt, startedAt, completedAt, cancelledAt any
	if values.GoalTiming != nil {
		observedAt, startedAt, completedAt, cancelledAt = values.GoalTiming.ObservedAt, values.GoalTiming.StartedAt, values.GoalTiming.CompletedAt, values.GoalTiming.CancelledAt
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO tasks (id, project_id, title, description, status, allow_agents, required_platform, assigned_to, type, parent_id, created_at, updated_at, started_at, completed_at, cancelled_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, statement_timestamp()), COALESCE($11::timestamptz, statement_timestamp()), $12, $13, CASE WHEN $11::timestamptz IS NOT NULL THEN $14::timestamptz WHEN $5 = 'cancelled' THEN statement_timestamp() ELSE NULL END)`, id, tx.projectID, values.Title, values.Description, values.Status, values.AllowAgents, values.RequiredPlatform, values.AssignedTo, taskType, values.ParentID, observedAt, startedAt, completedAt, cancelledAt)
	if err != nil {
		return model.Task{}, pg.QueryError("create task", err)
	}
	if err := pg.WriteTaskProperties(ctx, tx.tx, id, values.Properties); err != nil {
		return model.Task{}, err
	}
	if err := tx.insertDependencies(ctx, id, values.DependsOn, values.ExternalDependsOn); err != nil {
		return model.Task{}, err
	}
	return tx.Task(ctx, id)
}

func (tx *Writer) UpdateTask(ctx context.Context, id string, values TaskWrite) (model.Task, error) {
	properties, err := taskproperties.Normalize(values.Properties)
	if err != nil {
		return model.Task{}, pg.QueryError("validate task properties", err)
	}
	values.Properties = properties
	var observedAt, startedAt, completedAt, cancelledAt any
	if values.GoalTiming != nil {
		observedAt, startedAt, completedAt, cancelledAt = values.GoalTiming.ObservedAt, values.GoalTiming.StartedAt, values.GoalTiming.CompletedAt, values.GoalTiming.CancelledAt
	}
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET title = $3, description = $4, status = $5, allow_agents = $6, required_platform = $7, assigned_to = $8, parent_id = $9,
		started_at = CASE
			WHEN $10::timestamptz IS NOT NULL THEN $11::timestamptz
			WHEN status <> $5 AND $5 = 'in_progress' THEN statement_timestamp()
			WHEN status <> $5 AND $5 IN ('proposed', 'todo') THEN NULL
			WHEN status IN ('proposed', 'todo') AND $5 = 'done' THEN NULL
			ELSE started_at END,
		completed_at = CASE
			WHEN $10::timestamptz IS NOT NULL THEN $12::timestamptz
			WHEN status <> $5 AND $5 = 'done' THEN statement_timestamp()
			WHEN status <> $5 AND $5 IN ('proposed', 'todo', 'in_progress') THEN NULL
			ELSE completed_at END,
		cancelled_at = CASE
			WHEN $10::timestamptz IS NOT NULL THEN $13::timestamptz
            WHEN status <> $5 AND $5 = 'cancelled' THEN statement_timestamp()
            ELSE cancelled_at END,
        version = version + 1, updated_at = COALESCE($10::timestamptz, statement_timestamp()) WHERE project_id = $1 AND id = $2`,
		tx.projectID, id, values.Title, values.Description, values.Status, values.AllowAgents, values.RequiredPlatform, values.AssignedTo, values.ParentID, observedAt, startedAt, completedAt, cancelledAt)
	if err != nil {
		return model.Task{}, pg.QueryError("update task", err)
	}
	if result.RowsAffected() == 0 {
		return model.Task{}, pg.QueryError("update task", model.ErrNotFound)
	}
	if err := pg.WriteTaskProperties(ctx, tx.tx, id, values.Properties); err != nil {
		return model.Task{}, err
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM task_dependencies WHERE project_id = $1 AND task_id = $2`, tx.projectID, id); err != nil {
		return model.Task{}, pg.QueryError("replace dependencies", err)
	}
	if err := tx.insertDependencies(ctx, id, values.DependsOn, values.ExternalDependsOn); err != nil {
		return model.Task{}, err
	}
	return tx.Task(ctx, id)
}

func (tx *Writer) insertDependencies(ctx context.Context, id string, dependencies, externalDependencies []string) error {
	for _, dependency := range dependencies {
		if _, err := tx.tx.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, external)
			VALUES ($1, $2, $3, $4)`, tx.projectID, id, dependency, slices.Contains(externalDependencies, dependency)); err != nil {
			return pg.QueryError("insert dependency", err)
		}
	}
	return nil
}

func (tx *Writer) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := tx.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, pg.QueryError("read project clock", err)
	}
	return observed.UTC(), nil
}

func (tx *Writer) DependentIDs(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT t.id::text FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND d.depends_on_task_id = $2
		AND t.deleted_at IS NULL ORDER BY t.id`, tx.projectID, id)
	if err != nil {
		return nil, pg.QueryError("read dependents", err)
	}
	defer rows.Close()
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pg.QueryError("read dependents", err)
	}
	return ids, nil
}

func (tx *Writer) DeleteTask(ctx context.Context, id string, removeDepends bool) (model.TaskTombstone, error) {
	var tombstone model.TaskTombstone
	if removeDepends {
		if _, err := tx.tx.Exec(ctx, `WITH removed AS (
			DELETE FROM task_dependencies WHERE project_id = $1 AND depends_on_task_id = $2
			RETURNING task_id
		) UPDATE tasks SET version = version + 1, updated_at = statement_timestamp()
		WHERE project_id = $1 AND id IN (SELECT task_id FROM removed)`, tx.projectID, id); err != nil {
			return tombstone, pg.QueryError("remove dependent relationships", err)
		}
	}
	err := tx.tx.QueryRow(ctx, `UPDATE tasks SET deleted_at = statement_timestamp(),
		updated_at = statement_timestamp(), version = version + 1
		WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL
		RETURNING project_id::text, id::text, version, deleted_at`, tx.projectID, id).
		Scan(&tombstone.ProjectID, &tombstone.ID, &tombstone.Version, &tombstone.DeletedAt)
	if err != nil {
		return tombstone, pg.QueryError("delete task", err)
	}
	return tombstone, nil
}
