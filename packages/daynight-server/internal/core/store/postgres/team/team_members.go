package team

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func scanTeamMember(row pgx.Row) (model.TeamMember, error) {
	var m model.TeamMember
	err := row.Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt)
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	return m, err
}

const teamMemberColumns = `team_id::text,user_id::text,role,version,created_at,updated_at`

func (s *reader) TeamMembers(ctx context.Context, teamID string) ([]model.TeamMemberProfile, error) {
	rows, err := s.tx.Query(ctx, `SELECT m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at,u.name,u.email,u.avatar_url
 FROM team_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY m.created_at,m.user_id`, teamID)
	if err != nil {
		return nil, pg.QueryError("list Team members", err)
	}
	defer rows.Close()
	items := []model.TeamMemberProfile{}
	for rows.Next() {
		var item model.TeamMemberProfile
		m := &item.Membership
		if err := rows.Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL); err != nil {
			return nil, pg.QueryError("list Team members", err)
		}
		m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list Team members", err)
	}
	return items, nil
}

func (s *reader) TeamMembersPage(ctx context.Context, teamID string, page store.Page) (store.TeamMemberPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at,u.name,u.email,u.avatar_url
 FROM team_members m LEFT JOIN users u ON u.id=m.user_id
 WHERE m.team_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.user_id)>($2,$3::uuid))
 ORDER BY m.created_at,m.user_id LIMIT $4`, teamID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.TeamMemberPage{}, pg.QueryError("list Team members", err)
	}
	defer rows.Close()
	result := store.TeamMemberPage{Items: []model.TeamMemberProfile{}}
	for rows.Next() {
		var item model.TeamMemberProfile
		m := &item.Membership
		if err := rows.Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL); err != nil {
			return store.TeamMemberPage{}, pg.QueryError("list Team members", err)
		}
		if len(result.Items) == page.Limit {
			result.HasMore = true
			continue
		}
		m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.TeamMemberPage{}, pg.QueryError("list Team members", err)
	}
	return result, nil
}

func (tx *writer) Member(ctx context.Context, userID string) (model.TeamMember, error) {
	m, err := scanTeamMember(tx.tx.QueryRow(ctx, `SELECT `+teamMemberColumns+` FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE`, tx.teamID, userID))
	if err != nil {
		return model.TeamMember{}, pg.QueryError("read Team member", err)
	}
	return m, nil
}

func (tx *writer) MemberByExternalID(ctx context.Context, externalID string) (model.TeamMember, error) {
	m, err := scanTeamMember(tx.tx.QueryRow(ctx, `SELECT m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at
 FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND u.uniauth_id=$2`, tx.teamID, externalID))
	if err != nil {
		return model.TeamMember{}, pg.QueryError("resolve Team member", err)
	}
	return m, nil
}

func (tx *writer) AdminCount(ctx context.Context) (int64, error) {
	var count int64
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND role='admin'`, tx.teamID).Scan(&count)
	if err != nil {
		return 0, pg.QueryError("count Team administrators", err)
	}
	return count, nil
}

func (tx *writer) SetMemberRole(ctx context.Context, userID string, role model.ProjectRole) (model.TeamMember, error) {
	m, err := scanTeamMember(tx.tx.QueryRow(ctx, `UPDATE team_members SET role=$3,version=nextval('team_member_versions'),updated_at=statement_timestamp() WHERE team_id=$1 AND user_id=$2 RETURNING `+teamMemberColumns, tx.teamID, userID, role))
	if err != nil {
		return model.TeamMember{}, pg.QueryError("update Team member", err)
	}
	return m, nil
}

func (tx *writer) RemoveMember(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, tx.teamID, userID)
	if err != nil {
		return pg.QueryError("remove Team member", err)
	}
	return nil
}

func (tx *writer) AddMember(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) SELECT $1,id,$3 FROM users WHERE id=$2`, tx.teamID, user, role)
	if err != nil {
		return model.TeamMember{}, pg.QueryError("add Team member", err)
	}
	return tx.Member(ctx, user)
}
