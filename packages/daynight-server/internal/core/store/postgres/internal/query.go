package pg

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func PageValues(page store.Page) (any, any) {
	if page.After == nil {
		return nil, nil
	}
	return page.After.CreatedAt, page.After.ID
}

func QueryError(phase string, err error) error {
	failed, state := queryFailureFacts(err)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.Join(model.ErrNotFound, err)
	}
	return &store.Error{Phase: phase, Cause: err, DatabaseFailure: failed, SQLState: state}
}

// ConfirmedClosedCleanup retains the driver's rollback cause when a closed
// read-only connection has completed cleanup without marking it as a failure.
func ConfirmedClosedCleanup(cause error) error { return confirmedClosedCleanup{cause: cause} }

type confirmedClosedCleanup struct{ cause error }

func (err confirmedClosedCleanup) Error() string { return err.cause.Error() }
func (err confirmedClosedCleanup) Unwrap() error { return err.cause }

// QueryError also wraps validation and snapshot callbacks. Preserve those
// refusals while identifying driver failures anywhere in an error chain.
func queryFailureFacts(err error) (bool, string) {
	if err == nil {
		return false, ""
	}
	if failed, state := store.DatabaseErrorFacts(err); failed {
		return true, state
	}
	if failed, state := knownDriverFailure(err); failed {
		return true, state
	}
	if _, ok := err.(confirmedClosedCleanup); ok {
		return false, ""
	}
	switch err.(type) {
	case *model.Fault, *taskproperties.ValidationError, *store.Error:
		return false, ""
	}
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return true, ""
	}
	if err == model.ErrNotFound || err == pgx.ErrNoRows || err == context.Canceled || err == context.DeadlineExceeded {
		return false, ""
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var found bool
		for _, child := range joined.Unwrap() {
			failed, state := queryFailureFacts(child)
			found = found || failed
			if state != "" {
				return true, state
			}
		}
		return found, ""
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return queryFailureFacts(wrapped.Unwrap())
	}
	return true, ""
}

func AuthQueryError(phase string, err error) error {
	if err == nil {
		return nil
	}
	return QueryError(phase, err)
}

const ProjectProjection = `p.id::text, p.name, p.repo_url, p.created_at, p.updated_at, p.settings_version, p.execution_warning_minutes,
	owner_team.id::text, o.version, o.updated_at`

const ProjectRelation = `projects p LEFT JOIN project_ownership o ON o.project_id=p.id LEFT JOIN teams owner_team ON owner_team.id=o.team_id`

func ScanProject(row pgx.Row) (model.Project, error) {
	var project model.Project
	var teamID *string
	var version *int64
	var ownershipUpdatedAt *time.Time
	err := row.Scan(&project.ID, &project.Name, &project.RepoURL, &project.CreatedAt, &project.UpdatedAt, &project.Settings.Version, &project.Settings.ExecutionWarningMinutes,
		&teamID, &version, &ownershipUpdatedAt)
	if err != nil {
		return model.Project{}, err
	}
	if teamID == nil || version == nil || ownershipUpdatedAt == nil {
		return model.Project{}, fmt.Errorf("project ownership is missing")
	}
	project.Ownership = model.ProjectOwnership{TeamID: *teamID, Version: *version, UpdatedAt: ownershipUpdatedAt.UTC()}
	project.CreatedAt = project.CreatedAt.UTC()
	project.UpdatedAt = project.UpdatedAt.UTC()
	return project, err
}

const TaskProjection = `t.id::text, t.project_id::text, t.title, t.description,
	t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, t.required_platform, t.assigned_to::text, ` + TaskDependsOn + `, ` + TaskExternalDependsOn + `, ` + TaskBlockedBy + `, ` + TaskReady

const TaskDependsOn = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id ORDER BY d.depends_on_task_id)`

const TaskExternalDependsOn = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id AND d.external ORDER BY d.depends_on_task_id)`

const TaskBlockedBy = `ARRAY(SELECT d.depends_on_task_id::text FROM task_dependencies d
		WHERE d.project_id = t.project_id AND d.task_id = t.id
		AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id = d.project_id
			AND p.id = d.depends_on_task_id AND p.status = 'done') ORDER BY d.depends_on_task_id)`

const TaskReady = `(t.status = 'todo' AND NOT EXISTS (
	SELECT 1 FROM task_dependencies d WHERE d.project_id = t.project_id AND d.task_id = t.id
	AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id = d.project_id
		AND p.id = d.depends_on_task_id AND p.status = 'done')))`

func ScanTask(row pgx.Row, trailing ...any) (model.Task, error) {
	var task model.Task
	destinations := []any{&task.ID, &task.ProjectID, &task.Title, &task.Description, &task.Status,
		&task.Version, &task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.AllowAgents, &task.RequiredPlatform, &task.AssignedTo, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready}
	err := row.Scan(append(destinations, trailing...)...)
	if err != nil {
		return model.Task{}, err
	}
	if !task.Status.Valid() {
		return model.Task{}, fmt.Errorf("stored task status is invalid")
	}
	task.Properties = model.TaskProperties{}
	task.CreatedAt = task.CreatedAt.UTC()
	task.UpdatedAt = task.UpdatedAt.UTC()
	task.StartedAt = UTCTime(task.StartedAt)
	task.CompletedAt = UTCTime(task.CompletedAt)
	return task, err
}

func CollectTasks(rows pgx.Rows) ([]model.Task, error) {
	defer rows.Close()
	tasks := make([]model.Task, 0)
	for rows.Next() {
		task, err := ScanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func UTCTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

type LiveTaskRow struct{ pgx.Row }

func (row LiveTaskRow) Scan(destinations ...any) error {
	var deletedAt *time.Time
	if err := row.Row.Scan(append(destinations, &deletedAt)...); err != nil {
		return err
	}
	if deletedAt != nil {
		return model.ErrTaskDeleted
	}
	return nil
}

// knownDriverFailure traverses joined and wrapped causes while excluding the
// closed rollback that was verified as completed cleanup.
func knownDriverFailure(err error) (bool, string) {
	if err == nil {
		return false, ""
	}
	if _, ok := err.(confirmedClosedCleanup); ok {
		return false, ""
	}
	if databaseError, ok := err.(*pgconn.PgError); ok {
		return true, databaseError.Code
	}
	var found bool
	switch err.(type) {
	case *pgconn.ConnectError, *net.OpError:
		found = true
	}
	if err == pgconn.ErrConnClosed {
		found = true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			failed, state := knownDriverFailure(child)
			found = found || failed
			if state != "" {
				return true, state
			}
		}
		return found, ""
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		failed, state := knownDriverFailure(wrapped.Unwrap())
		return found || failed, state
	}
	return found, ""
}
