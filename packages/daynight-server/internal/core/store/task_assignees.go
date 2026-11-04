package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
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

func taskAssigneeProfile(userID string, profileID, name, avatarURL *string, hasProjectAccess bool) (core.TaskAssignee, error) {
	if profileID == nil || *profileID != userID {
		return core.TaskAssignee{}, fmt.Errorf("task assignee profile is missing or inconsistent")
	}
	return core.TaskAssignee{UserID: userID, Version: taskAssigneeContentVersion(userID, name, avatarURL), Name: name, AvatarURL: avatarURL, HasProjectAccess: hasProjectAccess}, nil
}

func taskAssigneeContentVersion(userID string, name, avatarURL *string) string {
	values := []*string{&userID, name, avatarURL}
	size := len(values) * 9
	for _, value := range values {
		if value != nil {
			size += len(*value)
		}
	}
	content := make([]byte, 0, size)
	for _, value := range values {
		if value == nil {
			content = append(content, 0)
		} else {
			content = append(content, 1)
			content = binary.BigEndian.AppendUint64(content, uint64(len(*value)))
			content = append(content, *value...)
		}
	}
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func (s *Snapshot) TaskAssignees(ctx context.Context, projectID string) (core.TaskAssignees, error) {
	rows, err := s.tx.Query(ctx, taskAssigneesCatalogueQuery, projectID)
	if err != nil {
		return core.TaskAssignees{}, queryError("list task assignees", err)
	}
	defer rows.Close()
	result := core.TaskAssignees{Items: []core.TaskAssignee{}, UnresolvedUserIDs: []string{}}
	for rows.Next() {
		var userID string
		var profileID, name, avatarURL *string
		var hasProjectAccess bool
		if err := rows.Scan(&userID, &profileID, &name, &avatarURL, &hasProjectAccess); err != nil {
			return core.TaskAssignees{}, queryError("list task assignees", err)
		}
		person, err := taskAssigneeProfile(userID, profileID, name, avatarURL, hasProjectAccess)
		if err != nil {
			return core.TaskAssignees{}, queryError("list task assignees", err)
		}
		result.Items = append(result.Items, person)
	}
	if err := rows.Err(); err != nil {
		return core.TaskAssignees{}, queryError("list task assignees", err)
	}
	return result, nil
}

func (s *Snapshot) ResolveTaskAssignees(ctx context.Context, projectID string, userIDs []string) (core.TaskAssignees, error) {
	rows, err := s.tx.Query(ctx, taskAssigneesResolveQuery, projectID, userIDs)
	if err != nil {
		return core.TaskAssignees{}, queryError("resolve task assignees", err)
	}
	defer rows.Close()
	result := core.TaskAssignees{Items: []core.TaskAssignee{}, UnresolvedUserIDs: []string{}}
	expected := make(map[string]bool, len(userIDs))
	for _, userID := range userIDs {
		expected[userID] = false
	}
	for rows.Next() {
		var userID string
		var profileID, name, avatarURL *string
		var hasProjectAccess, qualified bool
		if err := rows.Scan(&userID, &profileID, &name, &avatarURL, &hasProjectAccess, &qualified); err != nil {
			return core.TaskAssignees{}, queryError("resolve task assignees", err)
		}
		seen, exists := expected[userID]
		if !exists || seen {
			return core.TaskAssignees{}, queryError("resolve task assignees", fmt.Errorf("task assignee resolution contains an unexpected or duplicate user"))
		}
		expected[userID] = true
		if !qualified {
			if hasProjectAccess || profileID != nil || name != nil || avatarURL != nil {
				return core.TaskAssignees{}, queryError("resolve task assignees", fmt.Errorf("task assignee resolution contains an unqualified profile"))
			}
			result.UnresolvedUserIDs = append(result.UnresolvedUserIDs, userID)
			continue
		}
		person, err := taskAssigneeProfile(userID, profileID, name, avatarURL, hasProjectAccess)
		if err != nil {
			return core.TaskAssignees{}, queryError("resolve task assignees", err)
		}
		result.Items = append(result.Items, person)
	}
	if err := rows.Err(); err != nil {
		return core.TaskAssignees{}, queryError("resolve task assignees", err)
	}
	for _, seen := range expected {
		if !seen {
			return core.TaskAssignees{}, queryError("resolve task assignees", fmt.Errorf("task assignee resolution is incomplete"))
		}
	}
	return result, nil
}
