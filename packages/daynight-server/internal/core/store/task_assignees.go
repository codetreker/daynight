package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const taskAssigneesCatalogueQuery = `WITH candidate_ids (user_id) AS (
  SELECT user_id FROM (` + projectAccessRelation + `) access WHERE project_id = $1
  UNION
  SELECT assigned_to FROM tasks
  WHERE project_id = $1 AND deleted_at IS NULL AND assigned_to IS NOT NULL
)
SELECT candidate.user_id::text, profile.id::text, profile.name, profile.avatar_url,
  EXISTS (SELECT 1 FROM (` + projectAccessRelation + `) access WHERE access.project_id = $1 AND access.user_id = candidate.user_id)
FROM candidate_ids candidate
LEFT JOIN users profile ON profile.id = candidate.user_id
ORDER BY candidate.user_id`

const taskAssigneesResolveQuery = `SELECT requested.user_id::text, profile.id::text, profile.name, profile.avatar_url,
  access.user_id IS NOT NULL, access.user_id IS NOT NULL OR retained.id IS NOT NULL
FROM unnest($2::uuid[]) requested(user_id)
LEFT JOIN (` + projectAccessRelation + `) access ON access.project_id = $1 AND access.user_id = requested.user_id
LEFT JOIN LATERAL (
  SELECT task.id FROM tasks task
  WHERE task.project_id = $1 AND task.assigned_to = requested.user_id AND task.deleted_at IS NULL
  LIMIT 1
) retained ON true
LEFT JOIN users profile ON profile.id = requested.user_id AND (access.user_id IS NOT NULL OR retained.id IS NOT NULL)
ORDER BY requested.user_id`

func (s *Snapshot) TaskAssignees(ctx context.Context, projectID string) ([]model.TaskAssigneeFact, error) {
	rows, err := s.tx.Query(ctx, taskAssigneesCatalogueQuery, projectID)
	if err != nil {
		return nil, queryError("list task assignees", err)
	}
	defer rows.Close()
	facts := make([]model.TaskAssigneeFact, 0)
	for rows.Next() {
		var fact model.TaskAssigneeFact
		if err := rows.Scan(&fact.UserID, &fact.ProfileID, &fact.Name, &fact.AvatarURL, &fact.HasProjectAccess); err != nil {
			return nil, queryError("list task assignees", err)
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("list task assignees", err)
	}
	return facts, nil
}

func (s *Snapshot) ResolveTaskAssignees(ctx context.Context, projectID string, userIDs []string) ([]model.TaskAssigneeFact, error) {
	rows, err := s.tx.Query(ctx, taskAssigneesResolveQuery, projectID, userIDs)
	if err != nil {
		return nil, queryError("resolve task assignees", err)
	}
	defer rows.Close()
	facts := make([]model.TaskAssigneeFact, 0)
	for rows.Next() {
		var fact model.TaskAssigneeFact
		if err := rows.Scan(&fact.UserID, &fact.ProfileID, &fact.Name, &fact.AvatarURL, &fact.HasProjectAccess, &fact.Qualified); err != nil {
			return nil, queryError("resolve task assignees", err)
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("resolve task assignees", err)
	}
	return facts, nil
}
