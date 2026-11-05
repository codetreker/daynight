package store

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func scanTeamMember(row pgx.Row) (core.TeamMember, error) {
	var m core.TeamMember
	err := row.Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt)
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	return m, err
}

const teamMemberColumns = `team_id::text,user_id::text,role,version,created_at,updated_at`

func (s *Snapshot) TeamMembers(ctx context.Context, teamID string) ([]core.TeamMemberProfile, error) {
	rows, err := s.tx.Query(ctx, `SELECT m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at,u.id::text,u.name,u.email,u.avatar_url
 FROM team_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY m.created_at,m.user_id`, teamID)
	if err != nil {
		return nil, queryError("list Team members", err)
	}
	defer rows.Close()
	items := []core.TeamMemberProfile{}
	for rows.Next() {
		var item core.TeamMemberProfile
		var profileID *string
		m := &item.Membership
		if err := rows.Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt, &profileID, &item.Profile.Name, &item.Profile.Email, &item.Profile.AvatarURL); err != nil {
			return nil, queryError("list Team members", err)
		}
		if profileID == nil || *profileID != m.UserID {
			return nil, queryError("list Team members", fmt.Errorf("Team member profile is missing or inconsistent"))
		}
		m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("list Team members", err)
	}
	return items, nil
}

func (tx *TeamTx) Member(ctx context.Context, userID string) (core.TeamMember, error) {
	m, err := scanTeamMember(tx.tx.QueryRow(ctx, `SELECT `+teamMemberColumns+` FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE`, tx.teamID, userID))
	if err != nil {
		return core.TeamMember{}, queryError("read Team member", err)
	}
	return m, nil
}

func (tx *TeamTx) AdminCount(ctx context.Context) (int64, error) {
	var count int64
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND role='admin'`, tx.teamID).Scan(&count)
	if err != nil {
		return 0, queryError("count Team administrators", err)
	}
	return count, nil
}

func (tx *TeamTx) SetMemberRole(ctx context.Context, userID string, role core.ProjectRole) (core.TeamMember, error) {
	m, err := scanTeamMember(tx.tx.QueryRow(ctx, `UPDATE team_members SET role=$3,version=nextval('team_member_versions'),updated_at=statement_timestamp() WHERE team_id=$1 AND user_id=$2 RETURNING `+teamMemberColumns, tx.teamID, userID, role))
	if err != nil {
		return core.TeamMember{}, queryError("update Team member", err)
	}
	return m, nil
}

func (tx *TeamTx) RemoveMember(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, tx.teamID, userID)
	if err != nil {
		return queryError("remove Team member", err)
	}
	return nil
}
