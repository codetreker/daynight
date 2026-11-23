package task

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func NewProjectGoalDependencyWriter(tx pgx.Tx, projectID string) store.ProjectGoalDependencyDAO {
	return &goalDependencyWriter{tx: tx, projectID: projectID}
}

const projectGoalEdgeCandidates = `WITH goals AS (
 SELECT id FROM tasks WHERE project_id=$1 AND type='goal'
), edges AS (
 SELECT d.project_id,d.task_id,d.depends_on_task_id
 FROM goals g JOIN task_dependencies d ON d.project_id=$1 AND d.task_id=g.id AND d.dependency_type='goal'
 UNION
 SELECT d.project_id,d.task_id,d.depends_on_task_id
 FROM goals g JOIN task_dependencies d ON d.depends_on_task_id=g.id AND d.dependency_type='goal'
)`

func (d *goalDependencyWriter) HasProjectEdges(ctx context.Context) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `WITH goals AS (SELECT id FROM tasks WHERE project_id=$1 AND type='goal')
 SELECT EXISTS(SELECT 1 FROM goals g JOIN task_dependencies d ON d.project_id=$1 AND d.task_id=g.id WHERE d.dependency_type='goal')
 OR EXISTS(SELECT 1 FROM goals g JOIN task_dependencies d ON d.depends_on_task_id=g.id WHERE d.dependency_type='goal')`, d.projectID).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read project goal dependencies", err)
	}
	return found, nil
}

func (d *goalDependencyWriter) RemoveProjectEdges(ctx context.Context, deletingProject bool) error {
	rows, err := d.tx.Query(ctx, projectGoalEdgeCandidates+`, removed AS (
 DELETE FROM task_dependencies d USING edges e
 WHERE d.project_id=e.project_id AND d.task_id=e.task_id AND d.depends_on_task_id=e.depends_on_task_id AND d.dependency_type='goal'
 RETURNING d.task_id
 ) SELECT DISTINCT task_id::text FROM removed ORDER BY task_id::text`, d.projectID)
	if err != nil {
		return pg.QueryError("remove project goal dependencies", err)
	}
	var goals []string
	for rows.Next() {
		var goal string
		if err = rows.Scan(&goal); err != nil {
			break
		}
		goals = append(goals, goal)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("read removed project goal dependencies", err)
	}
	if len(goals) == 0 {
		return nil
	}
	if err = d.validateProjectRevisions(ctx, goals); err != nil {
		return err
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO goal_dependency_revisions(goal_id,revision)
 SELECT goal,2 FROM unnest($1::uuid[]) AS goal
 ON CONFLICT(goal_id) DO UPDATE SET revision=goal_dependency_revisions.revision+1`, goals)
	if err != nil {
		return pg.QueryError("advance project goal dependency revisions", err)
	}
	return d.touchLiveDownstreams(ctx, goals, deletingProject)
}

// Project locks are held before the Team graph lock and remain held here. A
// deleted source Project's Goals will not be visible when this transaction
// commits, while a transferred source Project remains visible.
func (d *goalDependencyWriter) touchLiveDownstreams(ctx context.Context, goals []string, deletingProject bool) error {
	rows, err := d.tx.Query(ctx, `SELECT t.id::text, t.version FROM tasks t JOIN projects p ON p.id=t.project_id
 WHERE t.id=ANY($1::uuid[]) AND t.type='goal' AND t.deleted_at IS NULL AND p.deleted_at IS NULL
 AND (NOT $2::boolean OR t.project_id<>$3::uuid) ORDER BY t.id`, goals, deletingProject, d.projectID)
	if err != nil {
		return pg.QueryError("read live downstream Goals", err)
	}
	var live []string
	for rows.Next() {
		var id string
		var version int64
		if err = rows.Scan(&id, &version); err != nil {
			break
		}
		if version == math.MaxInt64 {
			rows.Close()
			return &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
		}
		live = append(live, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("read live downstream Goals", err)
	}
	if len(live) == 0 {
		return nil
	}
	observed, err := NewWriter(d.tx, d.projectID).ObservedAt(ctx)
	if err != nil {
		return err
	}
	result, err := d.tx.Exec(ctx, `UPDATE tasks SET version=version+1,updated_at=$2 WHERE id=ANY($1::uuid[])`, live, observed)
	if err != nil {
		return pg.QueryError("touch downstream Goals", err)
	}
	if result.RowsAffected() != int64(len(live)) {
		return pg.QueryError("touch downstream Goals", model.ErrNotFound)
	}
	return nil
}

func (d *goalDependencyWriter) validateProjectRevisions(ctx context.Context, goals []string) error {
	rows, err := d.tx.Query(ctx, `SELECT revision FROM goal_dependency_revisions WHERE goal_id=ANY($1::uuid[]) ORDER BY goal_id FOR UPDATE`, goals)
	if err != nil {
		return pg.QueryError("read project goal dependency revisions", err)
	}
	defer rows.Close()
	for rows.Next() {
		var revision int64
		if err = rows.Scan(&revision); err != nil {
			return pg.QueryError("read project goal dependency revisions", err)
		}
		if revision == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Goal dependency revision is exhausted."}
		}
		if revision < 1 {
			return pg.QueryError("read project goal dependency revisions", errors.New("invalid goal dependency revision"))
		}
	}
	if err = rows.Err(); err != nil {
		return pg.QueryError("read project goal dependency revisions", err)
	}
	return nil
}
