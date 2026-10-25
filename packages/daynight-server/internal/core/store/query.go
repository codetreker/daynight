package store

import (
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5"
)

type Position struct {
	CreatedAt time.Time
	ID        string
}

type Page struct {
	After *Position
	Limit int
}

type ProjectPage struct {
	Items   []core.Project
	HasMore bool
}

type TaskQuery struct {
	Page               Page
	Status             *core.TaskStatus
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *core.TaskPlatform
}

type TaskPage struct {
	Items   []core.Task
	HasMore bool
}

func pageValues(page Page) (any, any) {
	if page.After == nil {
		return nil, nil
	}
	return page.After.CreatedAt, page.After.ID
}

func queryError(phase string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.Join(core.ErrNotFound, err)
	}
	return &Error{Phase: phase, Cause: err}
}

const projectProjection = `id::text, name, repo_url, created_at, updated_at, settings_version, execution_warning_minutes`

func scanProject(row pgx.Row) (core.Project, error) {
	var project core.Project
	err := row.Scan(&project.ID, &project.Name, &project.RepoURL, &project.CreatedAt, &project.UpdatedAt, &project.Settings.Version, &project.Settings.ExecutionWarningMinutes)
	project.CreatedAt = project.CreatedAt.UTC()
	project.UpdatedAt = project.UpdatedAt.UTC()
	return project, err
}

const taskProjection = `t.id::text, t.project_id::text, t.title, t.description,
	t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, t.required_platform, t.properties, ` + taskDependsOn + `, ` + taskExternalDependsOn + `, ` + taskBlockedBy + `, ` + taskReady

const taskDependsOn = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id ORDER BY d.depends_on_task_id)`

const taskExternalDependsOn = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id AND d.external ORDER BY d.depends_on_task_id)`

const taskBlockedBy = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id
		AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id = d.project_id
			AND p.id = d.depends_on_task_id AND p.status = 'done') ORDER BY d.depends_on_task_id)`

const taskReady = `(t.status = 'todo' AND NOT EXISTS (
	SELECT 1 FROM task_dependencies d WHERE d.project_id = t.project_id AND d.task_id = t.id
	AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id = d.project_id
		AND p.id = d.depends_on_task_id AND p.status = 'done')))`

func scanTask(row pgx.Row) (core.Task, error) {
	var task core.Task
	var properties string
	err := row.Scan(&task.ID, &task.ProjectID, &task.Title, &task.Description, &task.Status,
		&task.Version, &task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.AllowAgents, &task.RequiredPlatform, &properties, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready)
	if err != nil {
		return core.Task{}, err
	}
	if !task.Status.Valid() {
		return core.Task{}, fmt.Errorf("stored task status is invalid")
	}
	task.Properties, err = taskproperties.Decode([]byte(properties))
	if err != nil {
		return core.Task{}, err
	}
	task.CreatedAt = task.CreatedAt.UTC()
	task.UpdatedAt = task.UpdatedAt.UTC()
	task.StartedAt = utcTime(task.StartedAt)
	task.CompletedAt = utcTime(task.CompletedAt)
	return task, err
}

func collectTasks(rows pgx.Rows) ([]core.Task, error) {
	defer rows.Close()
	tasks := make([]core.Task, 0)
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func utcTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

type liveTaskRow struct{ pgx.Row }

func (row liveTaskRow) Scan(destinations ...any) error {
	var deletedAt *time.Time
	if err := row.Row.Scan(append(destinations, &deletedAt)...); err != nil {
		return err
	}
	if deletedAt != nil {
		return core.ErrTaskDeleted
	}
	return nil
}
