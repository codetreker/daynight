package pg

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

// ProjectAccessRelation keeps raw source user IDs so profile consumers detect
// missing users, and combines roles before any caller applies pagination.
const ProjectAccessRelation = `SELECT sources.project_id,sources.user_id,
    CASE WHEN bool_or(sources.role='admin') THEN 'admin' ELSE 'member' END AS role,
    min(sources.created_at) AS joined_at
    FROM (
        SELECT project_id,user_id,role,created_at FROM project_grants
        UNION ALL
        SELECT o.project_id,m.user_id,m.role,m.created_at FROM project_ownership o
        JOIN team_members m ON m.team_id=o.team_id
    ) sources JOIN projects live_project ON live_project.id=sources.project_id
    WHERE live_project.deleted_at IS NULL GROUP BY sources.project_id,sources.user_id`

type NullableProjectGrant struct {
	projectID, userID    *string
	role                 *model.ProjectRole
	version              *int64
	createdAt, updatedAt *time.Time
}

func (grant *NullableProjectGrant) Destinations() []any {
	return []any{&grant.projectID, &grant.userID, &grant.role, &grant.version, &grant.createdAt, &grant.updatedAt}
}

func (grant NullableProjectGrant) Value() *model.ProjectGrant {
	if grant.projectID == nil {
		return nil
	}
	return &model.ProjectGrant{ProjectID: *grant.projectID, UserID: *grant.userID, Role: *grant.role,
		Version: *grant.version, CreatedAt: *grant.createdAt, UpdatedAt: *grant.updatedAt}
}

// ReadProjectAccess evaluates both sources in one statement without row locks.
func ReadProjectAccess(ctx context.Context, tx pgx.Tx, userID, projectID string) (model.ProjectAccess, error) {
	var id string
	var ownershipID, teamID, ownerTeamID, accessUserID, profileID *string
	var role *model.ProjectRole
	var grant NullableProjectGrant
	var ownerName, personalUserID *string
	var ownershipVersion *int64
	var ownershipUpdatedAt *time.Time
	var teamRole *model.ProjectRole
	destinations := []any{&id, &ownershipID, &teamID, &ownerTeamID, &accessUserID, &profileID, &role, &ownerName, &personalUserID, &ownershipVersion, &ownershipUpdatedAt, &teamRole}
	err := tx.QueryRow(ctx, `SELECT p.id::text,o.project_id::text,o.team_id::text,t.id::text,a.user_id::text,u.id::text,a.role,t.name,t.personal_user_id::text,o.version,o.updated_at,m.role,
        g.project_id::text,g.user_id::text,g.role,g.version,g.created_at,g.updated_at
        FROM projects p LEFT JOIN project_ownership o ON o.project_id=p.id
        LEFT JOIN teams t ON t.id=o.team_id
        LEFT JOIN team_members m ON m.team_id=o.team_id AND m.user_id=$2
        LEFT JOIN (`+ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$2
        LEFT JOIN users u ON u.id=a.user_id
        LEFT JOIN project_grants g ON g.project_id=p.id AND g.user_id=$2
        WHERE p.id=$1 AND p.deleted_at IS NULL`, projectID, userID).Scan(append(destinations, grant.Destinations()...)...)
	if err != nil {
		return model.ProjectAccess{}, AuthQueryError("read project access", err)
	}
	if ownershipID == nil || teamID == nil || ownerTeamID == nil {
		return model.ProjectAccess{}, QueryError("read project access", fmt.Errorf("project ownership or owner Team is missing"))
	}
	if accessUserID == nil {
		return model.ProjectAccess{}, AuthQueryError("read project access", pgx.ErrNoRows)
	}
	if profileID == nil || *profileID != *accessUserID {
		return model.ProjectAccess{}, QueryError("read project access", fmt.Errorf("project access profile is missing or inconsistent"))
	}
	kind := "ordinary"
	if personalUserID != nil {
		kind = "personal"
	}
	return model.ProjectAccess{ProjectID: id, UserID: *accessUserID, Role: *role, DirectGrant: grant.Value(),
		OwnerTeam: model.TeamRef{ID: *ownerTeamID, Kind: kind, Name: ownerName},
		Ownership: model.ProjectOwnership{TeamID: *teamID, Version: *ownershipVersion, UpdatedAt: ownershipUpdatedAt.UTC()},
		TeamRole:  teamRole, CanTransfer: teamRole != nil && *teamRole == model.ProjectAdmin}, nil
}

// LockProjectAuthorization stabilizes ownership and each real source until commit.
// Task and credential locks precede it. Project is never locked here because
// ordinary writes acquire Project before Task. Source locks use a fixed order.
func LockProjectAuthorization(ctx context.Context, tx pgx.Tx, userID, projectID string) (model.ProjectAccess, error) {
	var teamID string
	var ownerName, personalUserID *string
	var ownership model.ProjectOwnership
	err := tx.QueryRow(ctx, `SELECT o.team_id::text,o.version,o.updated_at FROM project_ownership o
        WHERE o.project_id=$1 FOR SHARE OF o`, projectID).Scan(&teamID, &ownership.Version, &ownership.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return model.ProjectAccess{}, QueryError("lock project authorization", err)
	}
	// This separate statement follows any ownership lock wait. A joined check
	// in the lock statement could retain the snapshot from before that wait.
	var live bool
	if liveErr := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NULL)`, projectID).Scan(&live); liveErr != nil {
		return model.ProjectAccess{}, QueryError("read project presence", liveErr)
	}
	if !live {
		return model.ProjectAccess{}, QueryError("lock project authorization", pgx.ErrNoRows)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return model.ProjectAccess{}, QueryError("lock project authorization", fmt.Errorf("project ownership or owner Team is missing"))
	}
	// The ownership lock may have waited for a transfer. Read its Team in a
	// fresh statement snapshot, rather than retaining a join from before the wait.
	err = tx.QueryRow(ctx, `SELECT name,personal_user_id::text FROM teams WHERE id=$1`, teamID).Scan(&ownerName, &personalUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.ProjectAccess{}, QueryError("lock project authorization", fmt.Errorf("project owner Team is missing"))
	}
	if err != nil {
		return model.ProjectAccess{}, QueryError("read project owner Team", err)
	}
	var teamRole *model.ProjectRole
	var lockedTeamRole model.ProjectRole
	err = tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, teamID, userID).Scan(&lockedTeamRole)
	if err == nil {
		teamRole = &lockedTeamRole
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return model.ProjectAccess{}, QueryError("lock project team authorization", err)
	}
	var grant model.ProjectGrant
	err = tx.QueryRow(ctx, `SELECT project_id::text,user_id::text,role,version,created_at,updated_at
        FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE`, projectID, userID).Scan(
		&grant.ProjectID, &grant.UserID, &grant.Role, &grant.Version, &grant.CreatedAt, &grant.UpdatedAt)
	var directGrant *model.ProjectGrant
	if err == nil {
		directGrant = &grant
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return model.ProjectAccess{}, QueryError("lock project direct authorization", err)
	}
	if teamRole == nil && directGrant == nil {
		return model.ProjectAccess{}, QueryError("lock project authorization", pgx.ErrNoRows)
	}
	role := model.ProjectMemberRole
	if teamRole != nil && *teamRole == model.ProjectAdmin || directGrant != nil && directGrant.Role == model.ProjectAdmin {
		role = model.ProjectAdmin
	}
	kind := "ordinary"
	if personalUserID != nil {
		kind = "personal"
	}
	ownership.TeamID = teamID
	ownership.UpdatedAt = ownership.UpdatedAt.UTC()
	return model.ProjectAccess{ProjectID: projectID, UserID: userID, Role: role, DirectGrant: directGrant,
		OwnerTeam: model.TeamRef{ID: teamID, Kind: kind, Name: ownerName}, Ownership: ownership,
		TeamRole: teamRole, CanTransfer: teamRole != nil && *teamRole == model.ProjectAdmin}, nil
}
