package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

// projectAccessRelation keeps raw source user IDs so profile consumers detect
// missing users, and combines roles before any caller applies pagination.
const projectAccessRelation = `SELECT project_id,user_id,
    CASE WHEN bool_or(role='admin') THEN 'admin' ELSE 'member' END AS role,
    min(created_at) AS joined_at
    FROM (
        SELECT project_id,user_id,role,created_at FROM project_grants
        UNION ALL
        SELECT o.project_id,m.user_id,m.role,m.created_at FROM project_ownership o
        JOIN team_members m ON m.team_id=o.team_id
    ) sources GROUP BY project_id,user_id`

type nullableProjectGrant struct {
	projectID, userID    *string
	role                 *core.ProjectRole
	version              *int64
	createdAt, updatedAt *time.Time
}

func (grant *nullableProjectGrant) destinations() []any {
	return []any{&grant.projectID, &grant.userID, &grant.role, &grant.version, &grant.createdAt, &grant.updatedAt}
}

func (grant nullableProjectGrant) value() *core.ProjectGrant {
	if grant.projectID == nil {
		return nil
	}
	return &core.ProjectGrant{ProjectID: *grant.projectID, UserID: *grant.userID, Role: *grant.role,
		Version: *grant.version, CreatedAt: *grant.createdAt, UpdatedAt: *grant.updatedAt}
}

// ReadProjectAccess evaluates both sources in one statement without row locks.
func ReadProjectAccess(ctx context.Context, tx pgx.Tx, userID, projectID string) (core.ProjectAccess, error) {
	var id string
	var ownershipID, teamID, ownerTeamID, accessUserID, profileID *string
	var role *core.ProjectRole
	var grant nullableProjectGrant
	var ownerName, personalUserID *string
	var ownershipVersion *int64
	var ownershipUpdatedAt *time.Time
	var teamRole *core.ProjectRole
	destinations := []any{&id, &ownershipID, &teamID, &ownerTeamID, &accessUserID, &profileID, &role, &ownerName, &personalUserID, &ownershipVersion, &ownershipUpdatedAt, &teamRole}
	err := tx.QueryRow(ctx, `SELECT p.id::text,o.project_id::text,o.team_id::text,t.id::text,a.user_id::text,u.id::text,a.role,t.name,t.personal_user_id::text,o.version,o.updated_at,m.role,
        g.project_id::text,g.user_id::text,g.role,g.version,g.created_at,g.updated_at
        FROM projects p LEFT JOIN project_ownership o ON o.project_id=p.id
        LEFT JOIN teams t ON t.id=o.team_id
        LEFT JOIN team_members m ON m.team_id=o.team_id AND m.user_id=$2
        LEFT JOIN (`+projectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$2
        LEFT JOIN users u ON u.id=a.user_id
        LEFT JOIN project_grants g ON g.project_id=p.id AND g.user_id=$2
        WHERE p.id=$1`, projectID, userID).Scan(append(destinations, grant.destinations()...)...)
	if err != nil {
		return core.ProjectAccess{}, authQueryError("read project access", err)
	}
	if ownershipID == nil || teamID == nil || ownerTeamID == nil {
		return core.ProjectAccess{}, queryError("read project access", fmt.Errorf("project ownership or owner Team is missing"))
	}
	if accessUserID == nil {
		return core.ProjectAccess{}, authQueryError("read project access", pgx.ErrNoRows)
	}
	if profileID == nil || *profileID != *accessUserID {
		return core.ProjectAccess{}, queryError("read project access", fmt.Errorf("project access profile is missing or inconsistent"))
	}
	kind := "ordinary"
	if personalUserID != nil {
		kind = "personal"
	}
	return core.ProjectAccess{ProjectID: id, UserID: *accessUserID, Role: *role, DirectGrant: grant.value(),
		OwnerTeam: core.TeamRef{ID: *ownerTeamID, Kind: kind, Name: ownerName},
		Ownership: core.ProjectOwnership{TeamID: *teamID, Version: *ownershipVersion, UpdatedAt: ownershipUpdatedAt.UTC()},
		TeamRole:  teamRole, CanTransfer: teamRole != nil && *teamRole == core.ProjectAdmin}, nil
}

// LockProjectAuthorization stabilizes ownership and each real source until commit.
// Task and credential locks precede it. Project is never locked here because
// ordinary writes acquire Project before Task. Source locks use a fixed order.
func LockProjectAuthorization(ctx context.Context, tx pgx.Tx, userID, projectID string) (core.ProjectAccess, error) {
	var teamID string
	var ownerName, personalUserID *string
	var ownership core.ProjectOwnership
	err := tx.QueryRow(ctx, `SELECT o.team_id::text,o.version,o.updated_at FROM project_ownership o
        WHERE o.project_id=$1 FOR SHARE OF o`, projectID).Scan(&teamID, &ownership.Version, &ownership.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)`, projectID).Scan(&exists); err != nil {
			return core.ProjectAccess{}, queryError("read project presence", err)
		}
		if exists {
			return core.ProjectAccess{}, queryError("lock project authorization", fmt.Errorf("project ownership or owner Team is missing"))
		}
	}
	if err != nil {
		return core.ProjectAccess{}, queryError("lock project authorization", err)
	}
	// The ownership lock may have waited for a transfer. Read its Team in a
	// fresh statement snapshot, rather than retaining a join from before the wait.
	err = tx.QueryRow(ctx, `SELECT name,personal_user_id::text FROM teams WHERE id=$1`, teamID).Scan(&ownerName, &personalUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return core.ProjectAccess{}, queryError("lock project authorization", fmt.Errorf("project owner Team is missing"))
	}
	if err != nil {
		return core.ProjectAccess{}, queryError("read project owner Team", err)
	}
	var teamRole *core.ProjectRole
	var lockedTeamRole core.ProjectRole
	err = tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, teamID, userID).Scan(&lockedTeamRole)
	if err == nil {
		teamRole = &lockedTeamRole
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return core.ProjectAccess{}, queryError("lock project team authorization", err)
	}
	var grant core.ProjectGrant
	err = tx.QueryRow(ctx, `SELECT project_id::text,user_id::text,role,version,created_at,updated_at
        FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE`, projectID, userID).Scan(
		&grant.ProjectID, &grant.UserID, &grant.Role, &grant.Version, &grant.CreatedAt, &grant.UpdatedAt)
	var directGrant *core.ProjectGrant
	if err == nil {
		directGrant = &grant
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return core.ProjectAccess{}, queryError("lock project direct authorization", err)
	}
	if teamRole == nil && directGrant == nil {
		return core.ProjectAccess{}, queryError("lock project authorization", pgx.ErrNoRows)
	}
	role := core.ProjectMemberRole
	if teamRole != nil && *teamRole == core.ProjectAdmin || directGrant != nil && directGrant.Role == core.ProjectAdmin {
		role = core.ProjectAdmin
	}
	kind := "ordinary"
	if personalUserID != nil {
		kind = "personal"
	}
	ownership.TeamID = teamID
	ownership.UpdatedAt = ownership.UpdatedAt.UTC()
	return core.ProjectAccess{ProjectID: projectID, UserID: userID, Role: role, DirectGrant: directGrant,
		OwnerTeam: core.TeamRef{ID: teamID, Kind: kind, Name: ownerName}, Ownership: ownership,
		TeamRole: teamRole, CanTransfer: teamRole != nil && *teamRole == core.ProjectAdmin}, nil
}

func (tx *ThreadTx) LockProjectAuthorization(ctx context.Context, principal core.Principal, projectID string) (core.ProjectAccess, error) {
	return LockProjectAuthorization(ctx, tx.tx, principal.UserID, projectID)
}

func (s *Snapshot) ProjectAccess(ctx context.Context, principal core.Principal, projectID string) (core.ProjectAccess, error) {
	return ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}

func (tx *ProjectTx) ProjectAccess(ctx context.Context, principal core.Principal) (core.ProjectAccess, error) {
	return ReadProjectAccess(ctx, tx.tx, principal.UserID, tx.projectID)
}

type ProjectScopeKind string

const (
	ProjectScopeAll    ProjectScopeKind = "all"
	ProjectScopeTeam   ProjectScopeKind = "team"
	ProjectScopeShared ProjectScopeKind = "shared"
)

type ProjectScope struct {
	Kind   ProjectScopeKind
	TeamID string
}

func (s *Snapshot) AccessibleProjects(ctx context.Context, principal core.Principal, page Page) (ProjectPage, error) {
	return s.ScopedProjects(ctx, principal, ProjectScope{Kind: ProjectScopeAll}, page)
}

func (s *Snapshot) ScopedProjects(ctx context.Context, principal core.Principal, scope ProjectScope, page Page) (ProjectPage, error) {
	condition := ""
	var arguments []any
	switch scope.Kind {
	case ProjectScopeAll:
		if scope.TeamID != "" {
			return ProjectPage{}, queryError("list projects", fmt.Errorf("invalid project scope"))
		}
	case ProjectScopeTeam:
		if scope.TeamID == "" {
			return ProjectPage{}, queryError("list projects", fmt.Errorf("invalid project scope"))
		}
		var member int
		err := s.tx.QueryRow(ctx, `SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id
            WHERE t.id=$1 AND m.user_id=$2`, scope.TeamID, principal.UserID).Scan(&member)
		if err != nil {
			return ProjectPage{}, queryError("read team membership", err)
		}
		condition = ` AND o.team_id=$5::uuid`
		arguments = append(arguments, scope.TeamID)
	case ProjectScopeShared:
		if scope.TeamID != "" {
			return ProjectPage{}, queryError("list projects", fmt.Errorf("invalid project scope"))
		}
		condition = ` AND EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id=p.id AND g.user_id=$1)
            AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$1)`
	default:
		return ProjectPage{}, queryError("list projects", fmt.Errorf("invalid project scope"))
	}
	afterTime, afterID := pageValues(page)
	arguments = append([]any{principal.UserID, afterTime, afterID, page.Limit + 1}, arguments...)
	rows, err := s.tx.Query(ctx, `SELECT `+projectProjection+` FROM `+projectRelation+`
        WHERE EXISTS (SELECT 1 FROM (`+projectAccessRelation+`) a WHERE a.project_id=p.id AND a.user_id=$1)
        AND ($2::timestamptz IS NULL OR (p.created_at,p.id)>($2,$3::uuid))`+condition+`
		ORDER BY p.created_at,p.id LIMIT $4`, arguments...)
	if err != nil {
		return ProjectPage{}, queryError("list accessible projects", err)
	}
	defer rows.Close()
	items := []core.Project{}
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return ProjectPage{}, queryError("list accessible projects", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return ProjectPage{}, queryError("list accessible projects", err)
	}
	more := len(items) > page.Limit
	if more {
		items = items[:page.Limit]
	}
	return ProjectPage{Items: items, HasMore: more}, nil
}
