package project

import (
	"context"
	"errors"
	"fmt"
	"time"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

const memberProjection = `m.project_id::text,m.user_id::text,m.role,m.version,u.email,u.name,u.avatar_url,m.created_at,m.updated_at`

func scanMember(row pgx.Row) (model.ProjectMember, error) {
	var member model.ProjectMember
	err := row.Scan(&member.Grant.ProjectID, &member.Grant.UserID, &member.Grant.Role, &member.Grant.Version, &member.Email, &member.Name, &member.AvatarURL, &member.Grant.CreatedAt, &member.Grant.UpdatedAt)
	return member, err
}

func readDirectProjectMember(ctx context.Context, tx pgx.Tx, userID string, projectID string) (model.ProjectMember, error) {
	member, err := scanMember(tx.QueryRow(ctx, `SELECT `+memberProjection+` FROM project_grants m
        JOIN users u ON u.id=m.user_id JOIN projects p ON p.id=m.project_id
        WHERE m.project_id=$1 AND m.user_id=$2 AND p.deleted_at IS NULL`, projectID, userID))
	return member, pg.AuthQueryError("read project member", err)
}

func (s *reader) DirectProjectMember(ctx context.Context, userID, projectID string) (model.ProjectMember, error) {
	return readDirectProjectMember(ctx, s.tx, userID, projectID)
}

func (tx *writer) DirectProjectMember(ctx context.Context, userID string) (model.ProjectMember, error) {
	return readDirectProjectMember(ctx, tx.tx, userID, tx.projectID)
}

func (tx *creator) CreationPersonalTeam(ctx context.Context, lock bool) (PersonalTeamFacts, error) {
	var facts PersonalTeamFacts
	clause := ""
	if lock {
		clause = " FOR UPDATE"
	}
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`+clause, tx.userID).Scan(&facts.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PersonalTeamFacts{}, nil
	}
	if err != nil {
		return PersonalTeamFacts{}, pg.QueryError("read personal Team", err)
	}
	err = tx.tx.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE user_id=$2 AND role='admin') FROM team_members WHERE team_id=$1`, facts.ID, tx.userID).Scan(&facts.MemberCount, &facts.OwnerAdminCount)
	return facts, pg.AuthQueryError("read personal Team membership", err)
}

func (tx *creator) LockCreationTeam(ctx context.Context, teamID string) (ProjectCreationTeam, error) {
	var team ProjectCreationTeam
	err := tx.tx.QueryRow(ctx, `SELECT id::text,personal_user_id::text FROM teams WHERE id=$1 FOR UPDATE`, teamID).Scan(&team.ID, &team.PersonalUserID)
	return team, pg.AuthQueryError("lock creation Team", err)
}

func (tx *creator) CreationTeamMember(ctx context.Context, teamID string) (bool, error) {
	var role string
	err := tx.tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, tx.userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, pg.AuthQueryError("read creation Team membership", err)
}

func (tx *creator) InsertProject(ctx context.Context, id, name, repoURL, teamID string) (model.Project, model.ProjectAccess, error) {
	if _, err := tx.tx.Exec(ctx, `INSERT INTO projects (id,name,repo_url) VALUES ($1,$2,$3)`, id, name, repoURL); err != nil {
		return model.Project{}, model.ProjectAccess{}, pg.QueryError("insert project", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO project_ownership (project_id,team_id) VALUES ($1,$2)`, id, teamID); err != nil {
		return model.Project{}, model.ProjectAccess{}, pg.QueryError("insert project ownership", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) VALUES ($1,$2,'admin')`, id, tx.userID); err != nil {
		return model.Project{}, model.ProjectAccess{}, pg.QueryError("insert project administrator", err)
	}
	project, err := readProject(ctx, tx.tx, id)
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	access, err := pg.ReadProjectAccess(ctx, tx.tx, tx.userID, id)
	return project, access, err
}

func (s *reader) ProjectParticipants(ctx context.Context, projectID string) ([]model.ProjectParticipant, error) {
	rows, err := s.tx.Query(ctx, `SELECT a.user_id::text,u.id::text,u.name,u.email,u.avatar_url,a.role,tm.role,t.id::text,t.name,t.personal_user_id::text,
        g.project_id::text,g.user_id::text,g.role,g.version,g.created_at,g.updated_at FROM (`+pg.ProjectAccessRelation+`) a
        JOIN project_ownership o ON o.project_id=a.project_id
        JOIN teams t ON t.id=o.team_id
        LEFT JOIN team_members tm ON tm.team_id=o.team_id AND tm.user_id=a.user_id
        LEFT JOIN project_grants g ON g.project_id=a.project_id AND g.user_id=a.user_id
        LEFT JOIN users u ON u.id=a.user_id
        WHERE a.project_id=$1 ORDER BY a.joined_at,a.user_id`, projectID)
	if err != nil {
		return nil, pg.QueryError("list project participants", err)
	}
	defer rows.Close()
	participants := []model.ProjectParticipant{}
	for rows.Next() {
		var participant model.ProjectParticipant
		var profileID *string
		var grant pg.NullableProjectGrant
		var teamRole *model.ProjectRole
		var team model.TeamRef
		var personalUserID *string
		destinations := []any{&participant.UserID, &profileID, &participant.Profile.Name, &participant.Profile.Email, &participant.Profile.AvatarURL, &participant.EffectiveRole, &teamRole, &team.ID, &team.Name, &personalUserID}
		if err := rows.Scan(append(destinations, grant.Destinations()...)...); err != nil {
			return nil, pg.QueryError("list project participants", err)
		}
		if profileID == nil || *profileID != participant.UserID {
			return nil, pg.QueryError("list project participants", fmt.Errorf("project participant profile is missing or inconsistent"))
		}
		participant.DirectGrant = grant.Value()
		if teamRole != nil {
			team.Kind = "ordinary"
			if personalUserID != nil {
				team.Kind = "personal"
			}
			participant.InheritedFrom = &model.ProjectInheritance{Team: team, Role: *teamRole}
		}
		participants = append(participants, participant)
	}
	return participants, pg.AuthQueryError("list project participants", rows.Err())
}

func (tx *writer) SetMemberRole(ctx context.Context, userID string, role model.ProjectRole) (model.ProjectMember, error) {
	if _, err := tx.tx.Exec(ctx, `UPDATE project_grants SET role=$3,version=nextval('project_grant_versions'),
        updated_at=statement_timestamp() WHERE project_id=$1 AND user_id=$2`, tx.projectID, userID, role); err != nil {
		return model.ProjectMember{}, pg.QueryError("update member role", err)
	}
	return tx.DirectProjectMember(ctx, userID)
}

func (tx *writer) RemoveMember(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, tx.projectID, userID)
	return pg.AuthQueryError("remove project member", err)
}

func (tx *writer) AddInvitedMember(ctx context.Context, userID string) (model.ProjectMember, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) SELECT $1,id,'member' FROM users WHERE id=$2`, tx.projectID, userID)
	if err != nil {
		return model.ProjectMember{}, pg.QueryError("add invited member", err)
	}
	return tx.DirectProjectMember(ctx, userID)
}

const invitationProjection = `id::text,project_id::text,created_by::text,token_hash,created_at,expires_at,consumed_by::text,consumed_at,revoked_at`

func scanInvitation(row pgx.Row) (model.ProjectInvitation, error) {
	var invite model.ProjectInvitation
	err := row.Scan(&invite.ID, &invite.ProjectID, &invite.CreatedBy, &invite.TokenHash, &invite.CreatedAt, &invite.ExpiresAt, &invite.ConsumedBy, &invite.ConsumedAt, &invite.RevokedAt)
	return invite, err
}

func (s *reader) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	invite, err := scanInvitation(s.tx.QueryRow(ctx, `SELECT `+invitationProjection+` FROM project_invitations i WHERE token_hash=$1
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id=i.project_id AND p.deleted_at IS NULL)`, hash))
	return invite, pg.AuthQueryError("inspect invitation", err)
}

func (tx *writer) LockInvitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	invite, err := scanInvitation(tx.tx.QueryRow(ctx, `SELECT `+invitationProjection+` FROM project_invitations WHERE project_id=$1 AND token_hash=$2 FOR UPDATE`, tx.projectID, hash))
	return invite, pg.AuthQueryError("lock invitation", err)
}

func (tx *writer) CreateInvitation(ctx context.Context, invite model.ProjectInvitation) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM project_invitations WHERE id IN
        (SELECT id FROM project_invitations WHERE project_id=$1 AND expires_at<=$2
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, tx.projectID, invite.CreatedAt); err != nil {
		return pg.QueryError("clean expired invitations", err)
	}
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, invite.ID, tx.projectID, invite.CreatedBy, invite.TokenHash, invite.CreatedAt, invite.ExpiresAt)
	return pg.AuthQueryError("create invitation", err)
}

func (s *reader) Invitations(ctx context.Context, projectID string, now time.Time) ([]model.ProjectInvitation, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+invitationProjection+` FROM project_invitations
        WHERE project_id=$1 AND expires_at>$2 AND consumed_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at,id`, projectID, now)
	if err != nil {
		return nil, pg.QueryError("list invitations", err)
	}
	defer rows.Close()
	invites := []model.ProjectInvitation{}
	for rows.Next() {
		invite, err := scanInvitation(rows)
		if err != nil {
			return nil, pg.QueryError("list invitations", err)
		}
		invite.TokenHash = nil
		invites = append(invites, invite)
	}
	return invites, pg.AuthQueryError("list invitations", rows.Err())
}

func (tx *writer) RevokeInvitation(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE project_invitations SET revoked_at=COALESCE(revoked_at,$3)
        WHERE project_id=$1 AND id=$2 AND consumed_at IS NULL`, tx.projectID, id, now)
	return pg.AuthQueryError("revoke invitation", err)
}

func (tx *writer) ConsumeInvitation(ctx context.Context, id, userID string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE project_invitations SET consumed_by=$3,consumed_at=$4
        WHERE project_id=$1 AND id=$2`, tx.projectID, id, userID, now)
	return pg.AuthQueryError("consume invitation", err)
}

// DirectGrant locks the actual stored grant; a missing row is not a synthetic version.
func (tx *writer) DirectGrant(ctx context.Context, userID string) (model.ProjectGrant, error) {
	var grant model.ProjectGrant
	err := tx.tx.QueryRow(ctx, `SELECT project_id::text,user_id::text,role,version,created_at,updated_at
        FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, tx.projectID, userID).Scan(
		&grant.ProjectID, &grant.UserID, &grant.Role, &grant.Version, &grant.CreatedAt, &grant.UpdatedAt)
	return grant, pg.AuthQueryError("lock direct grant", err)
}

func (tx *writer) CreateGrant(ctx context.Context, userID string, role model.ProjectRole) (model.ProjectGrant, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) VALUES ($1,$2,$3)`, tx.projectID, userID, role)
	if err != nil {
		return model.ProjectGrant{}, pg.QueryError("create project grant", err)
	}
	return tx.DirectGrant(ctx, userID)
}
