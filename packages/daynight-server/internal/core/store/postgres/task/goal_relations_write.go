package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type goalRelationEditor struct {
	tx        pgx.Tx
	projectID string
}

func NewGoalRelationEditor(tx pgx.Tx, projectID string) store.GoalRelationEditor {
	return &goalRelationEditor{tx: tx, projectID: projectID}
}
func (d *goalRelationEditor) LockTeam(ctx context.Context) error {
	return pg.LockGoalDependencyTeam(ctx, d.tx, d.projectID)
}

func (d *goalRelationEditor) Admission(ctx context.Context, goalID, userID string, targets []store.GoalEndpoint) (store.GoalRelationAdmission, error) {
	projects := make([]string, 0, len(targets))
	goals := make([]string, 0, len(targets))
	for _, target := range targets {
		projects = append(projects, target.ProjectID)
		goals = append(goals, target.GoalID)
	}
	// This statement's snapshot is the authorization point for both ends. In
	// particular, Team revocation followed by a Project move cannot be combined
	// into a grant that never existed at a single point in time.
	rows, err := d.tx.Query(ctx, `WITH source AS (`+goalSourceRelation+`), requested AS (
 SELECT * FROM unnest($4::uuid[],$5::uuid[]) AS v(project_id,goal_id))
 SELECT s.*,q.project_id::text,q.goal_id::text,
 COALESCE(a.user_id IS NOT NULL AND t.type='goal' AND t.effective_deleted_at IS NULL AND p.deleted_at IS NULL,false),
 o.team_id::text,t.status
 FROM source s LEFT JOIN requested q ON true
 LEFT JOIN projects p ON p.id=q.project_id
 LEFT JOIN task_resource_rows t ON t.project_id=q.project_id AND t.id=q.goal_id
 LEFT JOIN project_ownership o ON o.project_id=p.id
 LEFT JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$3`, d.projectID, goalID, userID, projects, goals)
	if err != nil {
		return store.GoalRelationAdmission{}, pg.QueryError("read Goal edit admission", err)
	}
	defer rows.Close()
	result := store.GoalRelationAdmission{Targets: []store.GoalRelationCandidate{}}
	found := false
	for rows.Next() {
		found = true
		var kind *model.TaskType
		var status *model.TaskStatus
		var projectID, targetID, team *string
		var targetStatus *model.TaskStatus
		var available bool
		if err := rows.Scan(&kind, &status, &result.Source.Deleted, &result.Source.CanRead, &result.Source.TeamID, &result.Source.Revision, &projectID, &targetID, &available, &team, &targetStatus); err != nil {
			return result, pg.QueryError("scan Goal edit admission", err)
		}
		if kind != nil {
			result.Source.Type = *kind
			result.Source.Status = *status
		}
		result.Source.CanEdit = result.Source.CanRead
		if projectID != nil {
			candidate := store.GoalRelationCandidate{Endpoint: store.GoalEndpoint{ProjectID: *projectID, GoalID: *targetID}, Available: available}
			if team != nil {
				candidate.TeamID = *team
			}
			if targetStatus != nil {
				candidate.Status = *targetStatus
			}
			result.Targets = append(result.Targets, candidate)
		}
	}
	if err := rows.Err(); err != nil {
		return result, pg.QueryError("read Goal edit admission", err)
	}
	if !found {
		return result, model.ErrNotFound
	}
	if result.Source.Revision < 1 {
		return result, fmt.Errorf("invalid Goal dependency revision")
	}
	return result, nil
}
func (d *goalRelationEditor) Edges(ctx context.Context, goalID string) ([]store.GoalRelationEdge, error) {
	rows, err := d.tx.Query(ctx, `SELECT d.goal_edge_id::text,t.project_id::text,t.id::text,t.status
 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id
 WHERE d.project_id=$1 AND d.task_id=$2 AND d.dependency_type='goal' ORDER BY d.goal_edge_id`, d.projectID, goalID)
	if err != nil {
		return nil, pg.QueryError("read Goal edit edges", err)
	}
	defer rows.Close()
	result := []store.GoalRelationEdge{}
	for rows.Next() {
		var edge store.GoalRelationEdge
		if err := rows.Scan(&edge.ID, &edge.Endpoint.ProjectID, &edge.Endpoint.GoalID, &edge.Status); err != nil {
			return nil, pg.QueryError("scan Goal edit edges", err)
		}
		result = append(result, edge)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read Goal edit edges", err)
	}
	return result, nil
}
func (d *goalRelationEditor) Reaches(ctx context.Context, projectID, goalID, target string, removed []string) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `WITH RECURSIVE reachable(project_id,id) AS (
 SELECT $1::uuid,$2::uuid UNION
 SELECT t.project_id,t.id FROM reachable r
 JOIN task_dependencies d ON d.project_id=r.project_id AND d.task_id=r.id AND d.dependency_type='goal'
 JOIN tasks t ON t.id=d.depends_on_task_id
 WHERE NOT(d.goal_edge_id=ANY($4::uuid[])))
 SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$3)`, projectID, goalID, target, removed).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read Goal dependency reachability", err)
	}
	return found, nil
}
func (d *goalRelationEditor) Save(ctx context.Context, goalID string, revision int64, edges []store.GoalRelationEdge) error {
	ids := make([]string, 0, len(edges))
	goals := make([]string, 0, len(edges))
	for _, edge := range edges {
		ids = append(ids, edge.ID)
		goals = append(goals, edge.Endpoint.GoalID)
	}
	if _, err := d.tx.Exec(ctx, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND dependency_type='goal' AND NOT(goal_edge_id=ANY($3::uuid[]))`, d.projectID, goalID, ids); err != nil {
		return pg.QueryError("remove Goal dependency edges", err)
	}
	if _, err := d.tx.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id,external)
 SELECT $1,$2,v.goal_id,'goal',v.edge_id,false FROM unnest($3::uuid[],$4::uuid[]) AS v(goal_id,edge_id)
 ON CONFLICT(project_id,task_id,depends_on_task_id) DO NOTHING`, d.projectID, goalID, goals, ids); err != nil {
		return pg.QueryError("save Goal dependency edge", err)
	}
	command, err := d.tx.Exec(ctx, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,$2::bigint+1)
 ON CONFLICT(goal_id) DO UPDATE SET revision=$2+1 WHERE goal_dependency_revisions.revision=$2`, goalID, revision)
	if err != nil {
		return pg.QueryError("advance Goal dependency revision", err)
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("Goal dependency revision changed during locked edit")
	}
	return nil
}
