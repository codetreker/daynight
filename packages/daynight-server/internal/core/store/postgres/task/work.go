package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

const workComponents = `WITH RECURSIVE reach(seed,id) AS (
 SELECT id,id FROM tasks WHERE project_id=$1 AND deleted_at IS NULL AND status='in_progress' AND assigned_to=$2::uuid
 UNION
 SELECT member.seed,neighbor.id FROM reach member CROSS JOIN LATERAL (
 SELECT depends_on_task_id AS id FROM task_dependencies WHERE project_id=$1 AND task_id=member.id AND NOT external
 UNION SELECT task_id AS id FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=member.id AND NOT external
 ) neighbor JOIN LATERAL (SELECT id FROM tasks WHERE project_id=$1 AND id=neighbor.id AND deleted_at IS NULL OFFSET 0) live ON true
), labels AS (SELECT seed,min(id::text) AS group_id FROM reach GROUP BY seed),
 members AS MATERIALIZED (SELECT DISTINCT labels.group_id,reach.id FROM reach JOIN labels USING(seed)),
 roots AS MATERIALIZED (SELECT m.group_id,t.id,t.created_at FROM members m JOIN tasks t ON t.id=m.id AND t.project_id=$1
 WHERE NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN members p ON p.group_id=m.group_id AND p.id=d.depends_on_task_id
 WHERE d.project_id=$1 AND d.task_id=m.id AND NOT d.external)),
 groups AS (SELECT m.group_id,count(*) AS member_count,
 count(*) FILTER(WHERE t.status='in_progress' AND t.assigned_to=$2::uuid) AS matched_count,
 count(*) FILTER(WHERE t.status='in_progress') AS in_progress_count,
 max(t.started_at) FILTER(WHERE t.status='in_progress' AND t.assigned_to=$2::uuid) AS started_at,
 (SELECT count(*) FROM roots r WHERE r.group_id=m.group_id) AS root_count
 FROM members m JOIN tasks t ON t.id=m.id AND t.project_id=$1 GROUP BY m.group_id) `

func (s *Reader) TaskWorkGroups(ctx context.Context, projectID string, q store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	if q.Limit < 1 || q.Limit > 50 {
		return store.TaskWorkGroups{}, fmt.Errorf("invalid work group limit")
	}
	var afterTime, afterID any
	if q.After != nil {
		afterTime = q.After.StartedAt
		afterID = q.After.GroupID
	}
	rows, err := s.tx.Query(ctx, workComponents+`, page AS (
 SELECT * FROM groups WHERE ($3::timestamptz IS NULL OR started_at<$3 OR (started_at=$3 AND group_id>$4::text))
 AND ($5::text IS NULL OR group_id=$5) ORDER BY started_at DESC,group_id LIMIT $6)
 SELECT p.group_id,p.member_count,p.matched_count,p.in_progress_count,p.root_count,p.started_at,
 display.id::text,left(display.title,160),char_length(display.title)>160,
 preview.id::text,left(preview.title,160),char_length(preview.title)>160
 FROM page p
 JOIN LATERAL (SELECT t.id,t.title FROM roots r JOIN tasks t ON t.id=r.id WHERE r.group_id=p.group_id ORDER BY r.created_at,r.id LIMIT 1) display ON true
 LEFT JOIN LATERAL (SELECT t.id,t.title,r.created_at FROM roots r JOIN tasks t ON t.id=r.id WHERE r.group_id=p.group_id ORDER BY r.created_at,r.id LIMIT 5) preview ON true
 ORDER BY p.started_at DESC,p.group_id,preview.created_at,preview.id`, projectID, q.AssignedTo, afterTime, afterID, q.GroupID, q.Limit+1)
	if err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work groups", err)
	}
	defer rows.Close()
	result := store.TaskWorkGroups{Items: []store.TaskWorkGroup{}}
	for rows.Next() {
		var g store.TaskWorkGroup
		var rootID, title *string
		var truncated *bool
		if err := rows.Scan(&g.ID, &g.MemberCount, &g.MatchedCount, &g.InProgressCount, &g.RootCount, &g.StartedAt, &g.DisplayTaskID, &g.TitlePreview, &g.TitleTruncated, &rootID, &title, &truncated); err != nil {
			return store.TaskWorkGroups{}, pg.QueryError("read work groups", err)
		}
		if len(result.Items) == 0 || result.Items[len(result.Items)-1].ID != g.ID {
			g.StartedAt = g.StartedAt.UTC()
			g.Roots = []store.TaskWorkRoot{}
			result.Items = append(result.Items, g)
		}
		if rootID != nil {
			last := &result.Items[len(result.Items)-1]
			last.Roots = append(last.Roots, store.TaskWorkRoot{ID: *rootID, TitlePreview: *title, TitleTruncated: *truncated})
		}
	}
	if err := rows.Err(); err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work groups", err)
	}
	if len(result.Items) > q.Limit {
		result.Items = result.Items[:q.Limit]
		result.HasMore = true
	}
	return result, nil
}

const workTargetComponents = `WITH RECURSIVE members(group_id,id) AS (
 SELECT id::text,id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL
 UNION SELECT member.group_id,neighbor.id FROM members member CROSS JOIN LATERAL (
 SELECT depends_on_task_id AS id FROM task_dependencies WHERE project_id=$1 AND task_id=member.id AND NOT external
 UNION SELECT task_id AS id FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=member.id AND NOT external
 ) neighbor JOIN LATERAL (SELECT id FROM tasks WHERE project_id=$1 AND id=neighbor.id AND deleted_at IS NULL OFFSET 0) live ON true
) `

func (s *Reader) TaskWorkTargets(ctx context.Context, projectID string, groups []string, after *store.TaskWorkTargetPosition, limit int) (store.TaskWorkTargets, error) {
	if limit < 1 || limit > 200 || len(groups) > 50 {
		return store.TaskWorkTargets{}, fmt.Errorf("invalid work target batch")
	}
	var afterGroup, afterTask any
	if after != nil {
		afterGroup = after.GroupID
		afterTask = after.TaskID
	}
	rows, err := s.tx.Query(ctx, workTargetComponents+`SELECT m.group_id,t.id::text,t.version,t.assigned_to::text,t.started_at
 FROM members m JOIN tasks t ON t.id=m.id AND t.project_id=$1
 WHERE t.status='in_progress' AND ($3::text IS NULL OR (m.group_id,t.id)>($3::text,$4::uuid))
 ORDER BY m.group_id,t.id LIMIT $5`, projectID, groups, afterGroup, afterTask, limit+1)
	if err != nil {
		return store.TaskWorkTargets{}, pg.QueryError("read work targets", err)
	}
	defer rows.Close()
	result := store.TaskWorkTargets{Items: []store.TaskWorkTarget{}}
	for rows.Next() {
		var item store.TaskWorkTarget
		if err := rows.Scan(&item.GroupID, &item.Task.ID, &item.Task.Version, &item.Task.AssignedTo, &item.Task.StartedAt); err != nil {
			return store.TaskWorkTargets{}, pg.QueryError("read work targets", err)
		}
		item.Task.ProjectID = projectID
		item.Task.Status = model.TaskInProgress
		item.Task.StartedAt = pg.UTCTime(item.Task.StartedAt)
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.TaskWorkTargets{}, pg.QueryError("read work targets", err)
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore = true
	}
	return result, nil
}
