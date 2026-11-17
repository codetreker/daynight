package team

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *reader) MemberCandidates(ctx context.Context, query store.TeamMemberCandidateQuery) (store.TeamMemberCandidatePage, error) {
	rows, err := s.tx.Query(ctx, `SELECT u.id::text,u.name,u.email,u.avatar_url FROM users u
 WHERE ($2::uuid IS NULL OR u.id > $2::uuid)
 AND (strpos(translate(u.name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), $1) > 0
   OR strpos(translate(u.email, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), $1) > 0)
 ORDER BY u.id LIMIT $3`, query.Query, query.AfterID, query.Limit+1)
	if err != nil {
		return store.TeamMemberCandidatePage{}, pg.QueryError("search Team member candidates", err)
	}
	defer rows.Close()
	result := store.TeamMemberCandidatePage{Items: []model.TeamMemberCandidate{}}
	for rows.Next() {
		var item model.TeamMemberCandidate
		if err := rows.Scan(&item.UserID, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL); err != nil {
			return store.TeamMemberCandidatePage{}, pg.QueryError("search Team member candidates", err)
		}
		if len(result.Items) == query.Limit {
			result.HasMore = true
			continue
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.TeamMemberCandidatePage{}, pg.QueryError("search Team member candidates", err)
	}
	return result, nil
}

func (tx *writer) MemberCandidate(ctx context.Context, userID string) (model.TeamMemberCandidate, error) {
	var item model.TeamMemberCandidate
	err := tx.tx.QueryRow(ctx, `SELECT id::text,name,email,avatar_url FROM users WHERE id=$1`, userID).
		Scan(&item.UserID, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL)
	if err != nil {
		return model.TeamMemberCandidate{}, pg.QueryError("read Team member candidate", err)
	}
	return item, nil
}
