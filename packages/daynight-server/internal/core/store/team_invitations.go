package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

const teamInvitationProjection = `id::text,team_id::text,created_by::text,token_hash,created_at,expires_at,consumed_by::text,consumed_at,revoked_at`

func scanTeamInvitation(row pgx.Row) (model.TeamInvitation, error) {
	var i model.TeamInvitation
	err := row.Scan(&i.ID, &i.TeamID, &i.CreatedBy, &i.TokenHash, &i.CreatedAt, &i.ExpiresAt, &i.ConsumedBy, &i.ConsumedAt, &i.RevokedAt)
	return i, err
}
func (s *Snapshot) TeamInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	i, err := scanTeamInvitation(s.tx.QueryRow(ctx, `SELECT `+teamInvitationProjection+` FROM team_invitations WHERE token_hash=$1`, hash))
	return i, authQueryError("inspect Team invitation", err)
}
func (tx *TeamTx) LockInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	i, err := scanTeamInvitation(tx.tx.QueryRow(ctx, `SELECT `+teamInvitationProjection+` FROM team_invitations WHERE team_id=$1 AND token_hash=$2 FOR UPDATE`, tx.teamID, hash))
	return i, authQueryError("lock Team invitation", err)
}
func (tx *TeamTx) CreateInvitation(ctx context.Context, i model.TeamInvitation) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM team_invitations WHERE id IN (SELECT id FROM team_invitations WHERE team_id=$1 AND expires_at<=$2 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, tx.teamID, i.CreatedAt); err != nil {
		return queryError("clean expired Team invitations", err)
	}
	_, err := tx.tx.Exec(ctx, `INSERT INTO team_invitations (id,team_id,created_by,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, i.ID, tx.teamID, i.CreatedBy, i.TokenHash, i.CreatedAt, i.ExpiresAt)
	return authQueryError("create Team invitation", err)
}
func (s *Snapshot) TeamInvitations(ctx context.Context, id string, now time.Time) ([]model.TeamInvitation, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+teamInvitationProjection+` FROM team_invitations WHERE team_id=$1 AND expires_at>$2 AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at,id`, id, now)
	if err != nil {
		return nil, queryError("list Team invitations", err)
	}
	defer rows.Close()
	result := []model.TeamInvitation{}
	for rows.Next() {
		i, err := scanTeamInvitation(rows)
		if err != nil {
			return nil, queryError("list Team invitations", err)
		}
		i.TokenHash = nil
		result = append(result, i)
	}
	return result, authQueryError("list Team invitations", rows.Err())
}
func (tx *TeamTx) RevokeInvitation(ctx context.Context, id string, now time.Time) (bool, error) {
	result, err := tx.tx.Exec(ctx, `UPDATE team_invitations SET revoked_at=$3 WHERE team_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL`, tx.teamID, id, now)
	if err != nil {
		return false, authQueryError("revoke Team invitation", err)
	}
	return result.RowsAffected() == 1, nil
}
func (tx *TeamTx) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE team_invitations SET consumed_by=$3,consumed_at=$4 WHERE team_id=$1 AND id=$2`, tx.teamID, id, user, now)
	return authQueryError("consume Team invitation", err)
}
func readTeamRef(ctx context.Context, tx pgx.Tx, id string) (model.TeamRef, error) {
	var r model.TeamRef
	var owner *string
	err := tx.QueryRow(ctx, `SELECT id::text,name,personal_user_id::text FROM teams WHERE id=$1`, id).Scan(&r.ID, &r.Name, &owner)
	if err != nil {
		return r, authQueryError("read invitation Team", err)
	}
	r.Kind = "ordinary"
	if owner != nil {
		r.Kind = "personal"
	}
	return r, nil
}
func (s *Snapshot) InvitationTeam(ctx context.Context, id string) (model.TeamRef, error) {
	return readTeamRef(ctx, s.tx, id)
}
func (tx *TeamTx) InvitationTeam(ctx context.Context) (model.TeamRef, error) {
	return readTeamRef(ctx, tx.tx, tx.teamID)
}
func readTeamMember(ctx context.Context, tx pgx.Tx, team, user string, lock bool) (model.TeamMember, error) {
	var m model.TeamMember
	q := `SELECT team_id::text,user_id::text,role,version,created_at,updated_at FROM team_members WHERE team_id=$1 AND user_id=$2`
	if lock {
		q += ` FOR UPDATE`
	}
	err := tx.QueryRow(ctx, q, team, user).Scan(&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt)
	return m, authQueryError("read Team member", err)
}
func (s *Snapshot) InvitationTeamMember(ctx context.Context, team, user string) (model.TeamMember, error) {
	return readTeamMember(ctx, s.tx, team, user, false)
}
func (tx *TeamTx) InvitationMember(ctx context.Context, user string) (model.TeamMember, error) {
	return readTeamMember(ctx, tx.tx, tx.teamID, user, true)
}
func (tx *TeamTx) AddInvitedMember(ctx context.Context, user string) (model.TeamMember, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) SELECT $1,id,'member' FROM users WHERE id=$2`, tx.teamID, user)
	if err != nil {
		return model.TeamMember{}, queryError("add invited Team member", err)
	}
	return tx.InvitationMember(ctx, user)
}
