package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.PersonalTaskReader = (*Reader)(nil)

// The access relation combines direct and team grants before selection. The
// explicit child deletion condition also permits the partial index; the view's
// effective deletion condition accounts for a deleted parent Goal.
const personalMatchFilter = ` FROM task_resource_rows t
 JOIN (` + pg.ProjectAccessRelation + `) access ON access.project_id=t.project_id AND access.user_id=$1::uuid
 WHERE t.assigned_to=$1::uuid AND t.type='task' AND t.status='in_progress'
 AND t.deleted_at IS NULL AND t.effective_deleted_at IS NULL`

func (s *Reader) PersonalTaskFacts(ctx context.Context, actor string) ([]store.PersonalTaskProject, error) {
	rows, err := s.tx.Query(ctx, `WITH matched AS MATERIALIZED (SELECT t.project_id `+personalMatchFilter+`),
 counts AS (SELECT project_id,count(*)::text AS matched_count FROM matched GROUP BY project_id)
 SELECT p.id::text,p.name,o.team_id::text,
 CASE WHEN team.personal_user_id IS NULL THEN 'ordinary' ELSE 'personal' END,
 team.name,o.version,p.settings_version,p.execution_warning_minutes,counts.matched_count,
 p.task_cache_epoch::text, history.count, history.version_sum,team.id::text
 FROM counts JOIN projects p ON p.id=counts.project_id
 LEFT JOIN project_ownership o ON o.project_id=p.id LEFT JOIN teams team ON team.id=o.team_id
 CROSS JOIN LATERAL (SELECT count(*)::text AS count,COALESCE(sum(version::numeric),0)::text AS version_sum
 FROM tasks WHERE project_id=p.id) history ORDER BY p.id`, actor)
	if err != nil {
		return nil, pg.QueryError("read personal task facts", err)
	}
	defer rows.Close()
	result := []store.PersonalTaskProject{}
	for rows.Next() {
		var fact store.PersonalTaskProject
		var teamID, actualTeamID *string
		var ownershipVersion *int64
		if err := rows.Scan(&fact.ID, &fact.Name, &teamID, &fact.OwnerTeamKind, &fact.OwnerTeamName, &ownershipVersion, &fact.SettingsVersion, &fact.ExecutionWarningMinutes, &fact.MatchedCount, &fact.TaskCacheEpoch, &fact.AllTaskCount, &fact.AllTaskVersionSum, &actualTeamID); err != nil {
			return nil, pg.QueryError("read personal task facts", err)
		}
		if teamID == nil || actualTeamID == nil || ownershipVersion == nil || *teamID != *actualTeamID || fact.OwnerTeamKind == "ordinary" && fact.OwnerTeamName == nil || fact.OwnerTeamKind == "personal" && fact.OwnerTeamName != nil {
			return nil, pg.QueryError("read personal task facts", fmt.Errorf("invalid project ownership"))
		}
		fact.OwnerTeamID = *teamID
		fact.OwnershipVersion = *ownershipVersion
		result = append(result, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read personal task facts", err)
	}
	return result, nil
}

func (s *Reader) PersonalTaskPage(ctx context.Context, actor string, query store.PersonalTaskQuery) (store.PersonalTaskPage, error) {
	if query.Limit < 1 || query.Limit > 100 {
		return store.PersonalTaskPage{}, fmt.Errorf("invalid personal task limit")
	}
	var name, kind, teamName, teamID, projectID, started, taskID any
	hasAfter, hasStarted := false, false
	if p := query.After; p != nil {
		hasAfter = true
		name = p.ProjectName
		kind = p.OwnerTeamKind
		if p.OwnerTeamName != nil {
			teamName = *p.OwnerTeamName
		} else {
			teamName = ""
		}
		teamID = p.OwnerTeamID
		projectID = p.ProjectID
		taskID = p.TaskID
		if p.StartedAt != nil {
			hasStarted = true
			started = *p.StartedAt
		}
	}
	rows, err := s.tx.Query(ctx, `WITH matched AS (SELECT t.id,t.project_id,t.title,t.version,t.started_at,t.allow_agents,t.parent_id `+personalMatchFilter+`), candidates AS (
 SELECT m.*,p.name AS project_name,o.team_id,team.name AS team_name,
 CASE WHEN team.personal_user_id IS NULL THEN 'ordinary' ELSE 'personal' END AS team_kind
 FROM matched m JOIN projects p ON p.id=m.project_id JOIN project_ownership o ON o.project_id=p.id JOIN teams team ON team.id=o.team_id
 ), page AS (
 SELECT * FROM candidates c WHERE NOT $2::boolean OR
 (c.project_name COLLATE "C",c.team_kind COLLATE "C",COALESCE(c.team_name,'') COLLATE "C",c.team_id,c.project_id) > ($3::text COLLATE "C",$4::text COLLATE "C",$5::text COLLATE "C",$6::uuid,$7::uuid)
 OR ((c.project_name COLLATE "C",c.team_kind COLLATE "C",COALESCE(c.team_name,'') COLLATE "C",c.team_id,c.project_id) = ($3::text COLLATE "C",$4::text COLLATE "C",$5::text COLLATE "C",$6::uuid,$7::uuid)
 AND (($8::boolean AND (c.started_at<$9::timestamptz OR c.started_at IS NULL OR (c.started_at=$9::timestamptz AND c.id>$10::uuid))) OR (NOT $8::boolean AND c.started_at IS NULL AND c.id>$10::uuid)))
 ORDER BY c.project_name COLLATE "C",c.team_kind COLLATE "C",COALESCE(c.team_name,'') COLLATE "C",c.team_id,c.project_id,c.started_at DESC NULLS LAST,c.id LIMIT $11)
 SELECT page.project_id::text,page.id::text,page.title,page.version,page.started_at,page.allow_agents,
 page.parent_id::text,goal.title,paused.value,page.project_name,page.team_kind,page.team_name,page.team_id::text
 FROM page LEFT JOIN tasks goal ON goal.id=page.parent_id AND goal.project_id=page.project_id AND goal.type='goal'
 LEFT JOIN task_properties paused ON paused.task_id=page.id AND paused.name='paused'
 ORDER BY page.project_name COLLATE "C",page.team_kind COLLATE "C",COALESCE(page.team_name,'') COLLATE "C",page.team_id,page.project_id,page.started_at DESC NULLS LAST,page.id`, actor, hasAfter, name, kind, teamName, teamID, projectID, hasStarted, started, taskID, query.Limit+1)
	if err != nil {
		return store.PersonalTaskPage{}, pg.QueryError("read personal task page", err)
	}
	defer rows.Close()
	result := store.PersonalTaskPage{Items: []store.PersonalTaskRow{}}
	for rows.Next() {
		var row store.PersonalTaskRow
		if err := rows.Scan(&row.ProjectID, &row.ID, &row.Title, &row.Version, &row.StartedAt, &row.AllowAgents, &row.GoalID, &row.GoalTitle, &row.PausedRaw, &row.Position.ProjectName, &row.Position.OwnerTeamKind, &row.Position.OwnerTeamName, &row.Position.OwnerTeamID); err != nil {
			return store.PersonalTaskPage{}, pg.QueryError("read personal task page", err)
		}
		if (row.GoalID == nil) != (row.GoalTitle == nil) {
			return store.PersonalTaskPage{}, pg.QueryError("read personal task page", fmt.Errorf("invalid parent Goal"))
		}
		row.StartedAt = pg.UTCTime(row.StartedAt)
		row.Position.ProjectID = row.ProjectID
		row.Position.TaskID = row.ID
		row.Position.StartedAt = row.StartedAt
		result.Items = append(result.Items, row)
	}
	if err := rows.Err(); err != nil {
		return store.PersonalTaskPage{}, pg.QueryError("read personal task page", err)
	}
	if len(result.Items) > query.Limit {
		result.HasMore = true
		result.Items = result.Items[:query.Limit]
	}
	return result, nil
}
