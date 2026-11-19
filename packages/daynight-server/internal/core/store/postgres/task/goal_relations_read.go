package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type goalRelationReader struct{ tx pgx.Tx }

func NewGoalRelationReader(tx pgx.Tx) store.GoalRelationReader { return &goalRelationReader{tx: tx} }

const goalSourceRelation = `SELECT t.type,t.status,COALESCE(t.effective_deleted_at IS NOT NULL,false) AS deleted,
 a.user_id IS NOT NULL AS can_read,o.team_id::text,COALESCE(r.revision,1) AS revision
 FROM projects p JOIN project_ownership o ON o.project_id=p.id
 LEFT JOIN task_resource_rows t ON t.project_id=p.id AND t.id=$2
 LEFT JOIN goal_dependency_revisions r ON r.goal_id=t.id
 LEFT JOIN (` + pg.ProjectAccessRelation + `) a ON a.project_id=p.id AND a.user_id=$3
 WHERE p.id=$1 AND p.deleted_at IS NULL`

func (r *goalRelationReader) Source(ctx context.Context, projectID, goalID, userID string) (store.GoalRelationSource, error) {
	var result store.GoalRelationSource
	var kind *model.TaskType
	var status *model.TaskStatus
	err := r.tx.QueryRow(ctx, goalSourceRelation, projectID, goalID, userID).Scan(&kind, &status, &result.Deleted, &result.CanRead, &result.TeamID, &result.Revision)
	if err != nil {
		return result, pg.QueryError("read Goal relation source", err)
	}
	if kind != nil {
		result.Type = *kind
		result.Status = *status
	}
	result.CanEdit = result.CanRead
	if result.Revision < 1 {
		return result, fmt.Errorf("invalid Goal dependency revision")
	}
	return result, nil
}

func (r *goalRelationReader) Prerequisites(ctx context.Context, projectID, goalID, userID string) ([]store.GoalRelationEdge, error) {
	rows, err := r.tx.Query(ctx, `SELECT d.goal_edge_id::text,d.depends_on_task_id::text,
 t.project_id::text,t.status,
 CASE WHEN a.user_id IS NOT NULL THEN p.id::text END,
 CASE WHEN a.user_id IS NOT NULL THEN p.name END,
 CASE WHEN a.user_id IS NOT NULL THEN t.id::text END,
 CASE WHEN a.user_id IS NOT NULL THEN t.title END,
 CASE WHEN a.user_id IS NOT NULL THEN t.status END
 FROM task_dependencies d
 JOIN task_resource_rows t ON t.id=d.depends_on_task_id AND t.type='goal' AND t.effective_deleted_at IS NULL
 JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
 LEFT JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$3
 WHERE d.project_id=$1 AND d.task_id=$2 AND d.dependency_type='goal'
 ORDER BY d.goal_edge_id LIMIT 31`, projectID, goalID, userID)
	if err != nil {
		return nil, pg.QueryError("read Goal prerequisites", err)
	}
	defer rows.Close()
	result := []store.GoalRelationEdge{}
	for rows.Next() {
		var edge store.GoalRelationEdge
		var pID, pName, gID, title *string
		var status *model.TaskStatus
		if err := rows.Scan(&edge.ID, &edge.Endpoint.GoalID, &edge.Endpoint.ProjectID, &edge.Status, &pID, &pName, &gID, &title, &status); err != nil {
			return nil, pg.QueryError("scan Goal prerequisites", err)
		}
		if pID != nil {
			edge.Target = &store.GoalRelationTarget{ProjectID: *pID, ProjectName: *pName, GoalID: *gID, Title: *title, Status: *status, Kind: goalRelationKind(projectID, *pID)}
		}
		result = append(result, edge)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read Goal prerequisites", err)
	}
	return result, nil
}
func goalRelationKind(source, other string) string {
	if source == other {
		return "internal"
	}
	return "external"
}

func (r *goalRelationReader) Successors(ctx context.Context, projectID, goalID, userID, after string, limit int) ([]store.GoalRelationTarget, error) {
	var position *string
	if after != "" {
		position = &after
	}
	rows, err := r.tx.Query(ctx, `SELECT p.id::text,p.name,t.id::text,t.title,t.status
 FROM task_dependencies d JOIN task_resource_rows t ON t.project_id=d.project_id AND t.id=d.task_id AND t.type='goal' AND t.effective_deleted_at IS NULL
 JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
 JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$2
 WHERE d.depends_on_task_id=$1 AND d.dependency_type='goal' AND ($3::uuid IS NULL OR t.id>$3)
 ORDER BY t.id LIMIT $4`, goalID, userID, position, limit)
	if err != nil {
		return nil, pg.QueryError("read Goal successors", err)
	}
	defer rows.Close()
	result := []store.GoalRelationTarget{}
	for rows.Next() {
		var target store.GoalRelationTarget
		if err := rows.Scan(&target.ProjectID, &target.ProjectName, &target.GoalID, &target.Title, &target.Status); err != nil {
			return nil, pg.QueryError("scan Goal successors", err)
		}
		target.Kind = goalRelationKind(projectID, target.ProjectID)
		result = append(result, target)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read Goal successors", err)
	}
	return result, nil
}
