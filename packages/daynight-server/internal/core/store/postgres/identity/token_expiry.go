package identity

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func scanPAT(row pgx.Row) (model.PersonalAccessToken, error) {
	var c model.PersonalAccessToken
	err := row.Scan(&c.ID, &c.UserID, &c.Name, &c.CreatedAt, &c.ExpiresAt)
	c.CreatedAt = c.CreatedAt.UTC()
	if c.ExpiresAt != nil {
		expiry := c.ExpiresAt.UTC()
		c.ExpiresAt = &expiry
	}
	return c, err
}

const patFields = `id::text,user_id::text,name,created_at,expires_at`
