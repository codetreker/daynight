package store

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
        WHERE m.project_id=$1 AND m.user_id=$2`, projectID, userID))
	return member, authQueryError("read project member", err)
}

func (s *Snapshot) DirectProjectMember(ctx context.Context, userID, projectID string) (model.ProjectMember, error) {
	return readDirectProjectMember(ctx, s.tx, userID, projectID)
}

func (tx *ProjectTx) DirectProjectMember(ctx context.Context, userID string) (model.ProjectMember, error) {
	return readDirectProjectMember(ctx, tx.tx, userID, tx.projectID)
}

func (s *Store) CreatePrivateProject(ctx context.Context, principal model.Principal, id, name, repoURL string) (model.Project, error) {
	project, _, err := s.CreateProjectInTeam(ctx, principal, id, name, repoURL, nil)
	return project, err
}

func (s *Store) CreateProjectInTeam(ctx context.Context, principal model.Principal, id, name, repoURL string, targetTeamID *string) (model.Project, model.ProjectAccess, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, queryError("begin project creation", err)
	}
	project, access, err := createProjectInTeamTx(ctx, tx, principal, id, name, repoURL, targetTeamID)
	return project, access, authQueryError("create project", err)
}

func createProjectInTeamTx(ctx context.Context, tx pgx.Tx, principal model.Principal, id, name, repoURL string, targetTeamID *string) (model.Project, model.ProjectAccess, error) {
	var project model.Project
	var access model.ProjectAccess
	var err error
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		// The user must still exist; no implicit membership is created for an external ID.
		var userID string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR KEY SHARE`, principal.UserID).Scan(&userID); err != nil {
			return err
		}
		var teamID string
		if targetTeamID == nil {
			teamID, err = personalTeam(ctx, tx, userID, " FOR UPDATE")
			if err != nil {
				return err
			}
		} else {
			var personalOwner *string
			if err := tx.QueryRow(ctx, `SELECT id::text,personal_user_id::text FROM teams WHERE id=$1 FOR UPDATE`, *targetTeamID).Scan(&teamID, &personalOwner); err != nil {
				return err
			}
			if personalOwner != nil {
				if *personalOwner != userID {
					return pgx.ErrNoRows
				}
				if _, err := personalTeam(ctx, tx, userID, ""); err != nil {
					return err
				}
			} else {
				var role string
				if err := tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, userID).Scan(&role); err != nil {
					return err
				}
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO projects (id,name,repo_url) VALUES ($1,$2,$3)`, id, name, repoURL)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO project_ownership (project_id,team_id) VALUES ($1,$2)`, id, teamID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) VALUES ($1,$2,'admin')`, id, principal.UserID); err != nil {
			return err
		}
		project, err = readProject(ctx, tx, id)
		if err != nil {
			return err
		}
		access, err = ReadProjectAccess(ctx, tx, userID, id)
		return err
	})
	return project, access, err
}

func (s *Snapshot) ProjectParticipants(ctx context.Context, projectID string) ([]model.ProjectParticipant, error) {
	rows, err := s.tx.Query(ctx, `SELECT a.user_id::text,u.id::text,u.name,u.email,u.avatar_url,a.role,tm.role,t.id::text,t.name,t.personal_user_id::text,
        g.project_id::text,g.user_id::text,g.role,g.version,g.created_at,g.updated_at FROM (`+projectAccessRelation+`) a
        JOIN project_ownership o ON o.project_id=a.project_id
        JOIN teams t ON t.id=o.team_id
        LEFT JOIN team_members tm ON tm.team_id=o.team_id AND tm.user_id=a.user_id
        LEFT JOIN project_grants g ON g.project_id=a.project_id AND g.user_id=a.user_id
        LEFT JOIN users u ON u.id=a.user_id
        WHERE a.project_id=$1 ORDER BY a.joined_at,a.user_id`, projectID)
	if err != nil {
		return nil, queryError("list project participants", err)
	}
	defer rows.Close()
	participants := []model.ProjectParticipant{}
	for rows.Next() {
		var participant model.ProjectParticipant
		var profileID *string
		var grant nullableProjectGrant
		var teamRole *model.ProjectRole
		var team model.TeamRef
		var personalUserID *string
		destinations := []any{&participant.UserID, &profileID, &participant.Profile.Name, &participant.Profile.Email, &participant.Profile.AvatarURL, &participant.EffectiveRole, &teamRole, &team.ID, &team.Name, &personalUserID}
		if err := rows.Scan(append(destinations, grant.destinations()...)...); err != nil {
			return nil, queryError("list project participants", err)
		}
		if profileID == nil || *profileID != participant.UserID {
			return nil, queryError("list project participants", fmt.Errorf("project participant profile is missing or inconsistent"))
		}
		participant.DirectGrant = grant.value()
		if teamRole != nil {
			team.Kind = "ordinary"
			if personalUserID != nil {
				team.Kind = "personal"
			}
			participant.InheritedFrom = &model.ProjectInheritance{Team: team, Role: *teamRole}
		}
		participants = append(participants, participant)
	}
	return participants, authQueryError("list project participants", rows.Err())
}

func (tx *ProjectTx) SetMemberRole(ctx context.Context, userID string, role model.ProjectRole) (model.ProjectMember, error) {
	if _, err := tx.tx.Exec(ctx, `UPDATE project_grants SET role=$3,version=nextval('project_grant_versions'),
        updated_at=statement_timestamp() WHERE project_id=$1 AND user_id=$2`, tx.projectID, userID, role); err != nil {
		return model.ProjectMember{}, queryError("update member role", err)
	}
	return tx.DirectProjectMember(ctx, userID)
}

func (tx *ProjectTx) RemoveMember(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, tx.projectID, userID)
	return authQueryError("remove project member", err)
}

func (tx *ProjectTx) AddInvitedMember(ctx context.Context, userID string) (model.ProjectMember, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) SELECT $1,id,'member' FROM users WHERE id=$2`, tx.projectID, userID)
	if err != nil {
		return model.ProjectMember{}, queryError("add invited member", err)
	}
	return tx.DirectProjectMember(ctx, userID)
}

const invitationProjection = `id::text,project_id::text,created_by::text,token_hash,created_at,expires_at,consumed_by::text,consumed_at,revoked_at`

func scanInvitation(row pgx.Row) (model.ProjectInvitation, error) {
	var invite model.ProjectInvitation
	err := row.Scan(&invite.ID, &invite.ProjectID, &invite.CreatedBy, &invite.TokenHash, &invite.CreatedAt, &invite.ExpiresAt, &invite.ConsumedBy, &invite.ConsumedAt, &invite.RevokedAt)
	return invite, err
}

func (s *Snapshot) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	invite, err := scanInvitation(s.tx.QueryRow(ctx, `SELECT `+invitationProjection+` FROM project_invitations WHERE token_hash=$1`, hash))
	return invite, authQueryError("inspect invitation", err)
}

func (tx *ProjectTx) LockInvitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	invite, err := scanInvitation(tx.tx.QueryRow(ctx, `SELECT `+invitationProjection+` FROM project_invitations WHERE project_id=$1 AND token_hash=$2 FOR UPDATE`, tx.projectID, hash))
	return invite, authQueryError("lock invitation", err)
}

func (tx *ProjectTx) CreateInvitation(ctx context.Context, invite model.ProjectInvitation) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM project_invitations WHERE id IN
        (SELECT id FROM project_invitations WHERE project_id=$1 AND expires_at<=$2
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, tx.projectID, invite.CreatedAt); err != nil {
		return queryError("clean expired invitations", err)
	}
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, invite.ID, tx.projectID, invite.CreatedBy, invite.TokenHash, invite.CreatedAt, invite.ExpiresAt)
	return authQueryError("create invitation", err)
}

func (s *Snapshot) Invitations(ctx context.Context, projectID string, now time.Time) ([]model.ProjectInvitation, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+invitationProjection+` FROM project_invitations
        WHERE project_id=$1 AND expires_at>$2 AND consumed_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at,id`, projectID, now)
	if err != nil {
		return nil, queryError("list invitations", err)
	}
	defer rows.Close()
	invites := []model.ProjectInvitation{}
	for rows.Next() {
		invite, err := scanInvitation(rows)
		if err != nil {
			return nil, queryError("list invitations", err)
		}
		invite.TokenHash = nil
		invites = append(invites, invite)
	}
	return invites, authQueryError("list invitations", rows.Err())
}

func (tx *ProjectTx) RevokeInvitation(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE project_invitations SET revoked_at=COALESCE(revoked_at,$3)
        WHERE project_id=$1 AND id=$2 AND consumed_at IS NULL`, tx.projectID, id, now)
	return authQueryError("revoke invitation", err)
}

func (tx *ProjectTx) ConsumeInvitation(ctx context.Context, id, userID string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE project_invitations SET consumed_by=$3,consumed_at=$4
        WHERE project_id=$1 AND id=$2`, tx.projectID, id, userID, now)
	return authQueryError("consume invitation", err)
}

// DirectGrant locks the actual stored grant; a missing row is not a synthetic version.
func (tx *ProjectTx) DirectGrant(ctx context.Context, userID string) (model.ProjectGrant, error) {
	var grant model.ProjectGrant
	err := tx.tx.QueryRow(ctx, `SELECT project_id::text,user_id::text,role,version,created_at,updated_at
        FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, tx.projectID, userID).Scan(
		&grant.ProjectID, &grant.UserID, &grant.Role, &grant.Version, &grant.CreatedAt, &grant.UpdatedAt)
	return grant, authQueryError("lock direct grant", err)
}

func (tx *ProjectTx) CreateGrant(ctx context.Context, userID string, role model.ProjectRole) (model.ProjectGrant, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO project_grants (project_id,user_id,role) VALUES ($1,$2,$3)`, tx.projectID, userID, role)
	if err != nil {
		return model.ProjectGrant{}, queryError("create project grant", err)
	}
	return tx.DirectGrant(ctx, userID)
}
