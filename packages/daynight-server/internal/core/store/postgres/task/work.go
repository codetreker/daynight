package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/graph"
)

// All matching seeds share one deduplicated reachable set. A selected group
// starts from its own ID; membership and owner matching are validated below.
const workReachable = `WITH RECURSIVE reachable(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id=$1 AND effective_deleted_at IS NULL AND type='task'
 AND (($3::uuid IS NULL AND status='in_progress' AND assigned_to=$2::uuid) OR id=$3::uuid)
 UNION
 SELECT neighbor.id FROM reachable member CROSS JOIN LATERAL (
 SELECT depends_on_task_id AS id FROM task_dependencies WHERE project_id=$1 AND task_id=member.id AND dependency_type='task' AND NOT external
 UNION ALL SELECT task_id AS id FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=member.id AND dependency_type='task' AND NOT external
 ) neighbor JOIN task_resource_rows live ON live.project_id=$1 AND live.id=neighbor.id AND live.effective_deleted_at IS NULL AND live.type='task'
) SELECT id::text FROM reachable`

func (s *Reader) workMembership(ctx context.Context, project string, q store.TaskWorkQuery) ([]string, []string, error) {
	rows, err := s.tx.Query(ctx, workReachable, project, q.AssignedTo, q.GroupID)
	if err != nil {
		return nil, nil, pg.QueryError("read work vertices", err)
	}
	ids := []string{}
	index := map[string]int{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, pg.QueryError("scan work vertex", err)
		}
		index[id] = len(ids)
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, pg.QueryError("read work vertices", err)
	}
	if len(ids) == 0 {
		return ids, []string{}, nil
	}
	sets := graph.NewDisjointSets(len(ids))
	rows, err = s.tx.Query(ctx, `SELECT task_id::text,depends_on_task_id::text FROM task_dependencies
 WHERE project_id=$1 AND dependency_type='task' AND NOT external AND task_id=ANY($2::uuid[]) AND depends_on_task_id=ANY($2::uuid[])`, project, ids)
	if err != nil {
		return nil, nil, pg.QueryError("read work edges", err)
	}
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			rows.Close()
			return nil, nil, pg.QueryError("scan work edge", err)
		}
		ai, aok := index[a]
		bi, bok := index[b]
		if !aok || !bok {
			rows.Close()
			return nil, nil, fmt.Errorf("work edge references missing vertex")
		}
		sets.Union(ai, bi)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, pg.QueryError("read work edges", err)
	}
	minima := make(map[int]string, len(ids))
	for i, id := range ids {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		root := sets.Find(i)
		if old, ok := minima[root]; !ok || id < old {
			minima[root] = id
		}
	}
	groups := make([]string, len(ids))
	for i := range ids {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		groups[i] = minima[sets.Find(i)]
	}
	return ids, groups, nil
}

const workComponents = `WITH members AS MATERIALIZED (SELECT group_id::text,id FROM unnest($7::uuid[],$8::uuid[]) AS m(id,group_id)),
 non_roots AS MATERIALIZED (SELECT DISTINCT d.task_id FROM members p JOIN task_dependencies d ON d.depends_on_task_id=p.id
 WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external),
 roots AS MATERIALIZED (SELECT m.group_id,t.id,t.created_at FROM members m JOIN tasks t ON t.id=m.id AND t.project_id=$1
 LEFT JOIN non_roots n ON n.task_id=m.id WHERE n.task_id IS NULL),
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
	ids, groupIDs, err := s.workMembership(ctx, projectID, q)
	if err != nil {
		return store.TaskWorkGroups{}, err
	}
	result := store.TaskWorkGroups{Items: []store.TaskWorkGroup{}, Targets: []store.TaskWorkTargetPosition{}}
	if len(ids) == 0 {
		return result, nil
	}
	var afterTime, afterID any
	if q.After != nil {
		afterTime, afterID = q.After.StartedAt, q.After.GroupID
	}
	rows, err := s.tx.Query(ctx, workComponents+`, page AS (
 SELECT * FROM groups WHERE matched_count>0 AND ($3::timestamptz IS NULL OR started_at<$3 OR (started_at=$3 AND group_id>$4::text))
 AND ($5::text IS NULL OR group_id=$5) ORDER BY started_at DESC,group_id LIMIT $6)
 SELECT p.group_id,p.member_count,p.matched_count,p.in_progress_count,p.root_count,p.started_at,
 display.id::text,left(display.title,160),char_length(display.title)>160,
 preview.id::text,left(preview.title,160),char_length(preview.title)>160
 FROM page p
 JOIN LATERAL (SELECT t.id,t.title FROM roots r JOIN tasks t ON t.id=r.id WHERE r.group_id=p.group_id ORDER BY r.created_at,r.id LIMIT 1) display ON true
 LEFT JOIN LATERAL (SELECT t.id,t.title,r.created_at FROM roots r JOIN tasks t ON t.id=r.id WHERE r.group_id=p.group_id ORDER BY r.created_at,r.id LIMIT 5) preview ON true
 ORDER BY p.started_at DESC,p.group_id,preview.created_at,preview.id`, projectID, q.AssignedTo, afterTime, afterID, q.GroupID, q.Limit+1, ids, groupIDs)
	if err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work groups", err)
	}
	for rows.Next() {
		var g store.TaskWorkGroup
		var rootID, title *string
		var truncated *bool
		if err := rows.Scan(&g.ID, &g.MemberCount, &g.MatchedCount, &g.InProgressCount, &g.RootCount, &g.StartedAt, &g.DisplayTaskID, &g.TitlePreview, &g.TitleTruncated, &rootID, &title, &truncated); err != nil {
			rows.Close()
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
	err = rows.Err()
	rows.Close()
	if err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work groups", err)
	}
	if len(result.Items) > q.Limit {
		result.Items = result.Items[:q.Limit]
		result.HasMore = true
	}
	selected := make([]string, len(result.Items))
	for i, group := range result.Items {
		selected[i] = group.ID
	}
	rows, err = s.tx.Query(ctx, `WITH members AS (SELECT group_id::text,id FROM unnest($2::uuid[],$3::uuid[]) AS m(id,group_id))
 SELECT m.group_id,t.id::text FROM members m JOIN tasks t ON t.project_id=$1 AND t.id=m.id
 WHERE m.group_id=ANY($4::text[]) AND t.status='in_progress' ORDER BY m.group_id,t.id`, projectID, ids, groupIDs, selected)
	if err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work target keys", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key store.TaskWorkTargetPosition
		if err := rows.Scan(&key.GroupID, &key.TaskID); err != nil {
			return store.TaskWorkGroups{}, pg.QueryError("scan work target key", err)
		}
		result.Targets = append(result.Targets, key)
	}
	if err := rows.Err(); err != nil {
		return store.TaskWorkGroups{}, pg.QueryError("read work target keys", err)
	}
	return result, nil
}

func (s *Reader) TaskWorkTargets(ctx context.Context, projectID string, keys []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
	if len(keys) < 1 || len(keys) > 200 {
		return store.TaskWorkTargets{}, fmt.Errorf("invalid work target batch")
	}
	groups, ids := make([]string, len(keys)), make([]string, len(keys))
	for i, key := range keys {
		if i > 0 && (key.GroupID < keys[i-1].GroupID || key.GroupID == keys[i-1].GroupID && key.TaskID <= keys[i-1].TaskID) {
			return store.TaskWorkTargets{}, fmt.Errorf("work target keys are not strictly ordered")
		}
		groups[i], ids[i] = key.GroupID, key.TaskID
	}
	rows, err := s.tx.Query(ctx, `SELECT k.group_id::text,t.id::text,t.version,t.assigned_to::text,t.started_at
 FROM unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY AS k(group_id,task_id,ordinal)
 JOIN task_resource_rows t ON t.project_id=$1 AND t.id=k.task_id AND t.effective_deleted_at IS NULL AND t.type='task' AND t.status='in_progress'
 ORDER BY k.ordinal`, projectID, groups, ids)
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
	if len(result.Items) != len(keys) {
		return store.TaskWorkTargets{}, fmt.Errorf("work target results do not match selected keys")
	}
	for i, item := range result.Items {
		if item.GroupID != keys[i].GroupID || item.Task.ID != keys[i].TaskID {
			return store.TaskWorkTargets{}, fmt.Errorf("work target result does not match selected key")
		}
	}
	return result, nil
}
