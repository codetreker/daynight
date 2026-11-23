package task

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskSyncGoalDependsOn(ctx context.Context, projectID string, goalIDs []string) (map[string][]string, error) {
	result := make(map[string][]string, len(goalIDs))
	if len(goalIDs) == 0 {
		return result, nil
	}
	rows, err := s.tx.Query(ctx, `SELECT source.id::text,
 COALESCE(array_agg(target.id::text ORDER BY target.id) FILTER (WHERE target.id IS NOT NULL), ARRAY[]::text[])
 FROM task_resource_rows source JOIN projects project ON project.id=source.project_id AND project.deleted_at IS NULL
 LEFT JOIN task_dependencies d ON d.project_id=source.project_id AND d.task_id=source.id AND d.dependency_type='goal'
 LEFT JOIN task_resource_rows target ON target.project_id=source.project_id AND target.id=d.depends_on_task_id
  AND target.type='goal' AND target.effective_deleted_at IS NULL
 WHERE source.project_id=$1 AND source.id=ANY($2::uuid[]) AND source.type='goal' AND source.effective_deleted_at IS NULL
 GROUP BY source.id ORDER BY source.id`, projectID, goalIDs)
	if err != nil {
		return nil, pg.QueryError("read task sync Goal prerequisites", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var prerequisites []string
		if err := rows.Scan(&id, &prerequisites); err != nil {
			return nil, pg.QueryError("read task sync Goal prerequisites", err)
		}
		result[id] = prerequisites
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task sync Goal prerequisites", err)
	}
	return result, nil
}
