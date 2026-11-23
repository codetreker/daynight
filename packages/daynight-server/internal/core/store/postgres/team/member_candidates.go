package team

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (tx *writer) MemberCandidate(ctx context.Context, userID string) (model.UserCandidate, error) {
	var item model.UserCandidate
	err := tx.tx.QueryRow(ctx, `SELECT id::text,name,email,avatar_url FROM users WHERE id=$1`, userID).
		Scan(&item.UserID, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL)
	if err != nil {
		return model.UserCandidate{}, pg.QueryError("read Team member candidate", err)
	}
	return item, nil
}
