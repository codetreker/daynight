package team

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type reader struct{ tx pgx.Tx }
type writer struct {
	tx     pgx.Tx
	teamID string
}
type creator struct {
	tx     pgx.Tx
	userID string
}

func NewReader(tx pgx.Tx) store.TeamReader                  { return &reader{tx: tx} }
func NewWriter(tx pgx.Tx, teamID string) store.TeamWriteDAO { return &writer{tx: tx, teamID: teamID} }
func NewCreation(tx pgx.Tx, userID string) store.TeamCreationDAO {
	return &creator{tx: tx, userID: userID}
}

var _ store.TeamReader = (*reader)(nil)
var _ store.TeamWriteDAO = (*writer)(nil)
var _ store.TeamCreationDAO = (*creator)(nil)

const teamProjection = `t.id::text,t.personal_user_id::text,t.name,t.version,t.created_at,t.updated_at,
	m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at`

func scanTeam(row pgx.Row) (model.Team, error) {
	var team model.Team
	var owner *string
	m := &team.Membership
	err := row.Scan(&team.ID, &owner, &team.Name, &team.Version, &team.CreatedAt, &team.UpdatedAt,
		&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return model.Team{}, err
	}
	team.Kind = "ordinary"
	if owner != nil {
		team.Kind = "personal"
		if team.Name != nil || m.UserID != *owner || m.Role != model.ProjectAdmin {
			return model.Team{}, fmt.Errorf("Personal Team membership is invalid")
		}
	} else if team.Name == nil {
		return model.Team{}, fmt.Errorf("ordinary Team name is missing")
	}
	team.CreatedAt, team.UpdatedAt = team.CreatedAt.UTC(), team.UpdatedAt.UTC()
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	return team, nil
}

func readTeam(ctx context.Context, tx pgx.Tx, userID, teamID string) (model.Team, error) {
	team, err := scanTeam(tx.QueryRow(ctx, `SELECT `+teamProjection+` FROM teams t
		JOIN team_members m ON m.team_id=t.id WHERE t.id=$1 AND m.user_id=$2`, teamID, userID))
	if err != nil {
		return model.Team{}, pg.QueryError("read Team", err)
	}
	return team, nil
}

func (s *reader) Team(ctx context.Context, userID, teamID string) (model.Team, error) {
	return readTeam(ctx, s.tx, userID, teamID)
}

// readTeamBounded suppresses oversized names in the SQL projection before
// PostgreSQL transfers the row to the application.
func readTeamBounded(ctx context.Context, tx pgx.Tx, userID, teamID string, limit int) (model.Team, bool, error) {
	row := tx.QueryRow(ctx, `SELECT `+boundedTeamProjection+`, coalesce(octet_length(t.name)>$3,false) FROM teams t
 JOIN team_members m ON m.team_id=t.id WHERE t.id=$1 AND m.user_id=$2`, teamID, userID, limit)
	t, oversized, err := scanBoundedTeam(row)
	if err != nil {
		return model.Team{}, false, pg.QueryError("read Team", err)
	}
	return t, oversized, nil
}

const boundedTeamProjection = `t.id::text,t.personal_user_id::text,CASE WHEN octet_length(t.name)>$3 THEN '' ELSE t.name END,t.version,t.created_at,t.updated_at,
 m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at`

func scanBoundedTeam(row pgx.Row) (model.Team, bool, error) {
	var t model.Team
	var owner *string
	var oversized bool
	m := &t.Membership
	err := row.Scan(&t.ID, &owner, &t.Name, &t.Version, &t.CreatedAt, &t.UpdatedAt, &m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt, &oversized)
	if err != nil {
		return model.Team{}, false, err
	}
	t.Kind = "ordinary"
	if owner != nil {
		t.Kind = "personal"
		if t.Name != nil || m.UserID != *owner || m.Role != model.ProjectAdmin {
			return model.Team{}, false, fmt.Errorf("Personal Team membership is invalid")
		}
	} else if t.Name == nil {
		return model.Team{}, false, fmt.Errorf("ordinary Team name is missing")
	}
	t.CreatedAt, t.UpdatedAt = t.CreatedAt.UTC(), t.UpdatedAt.UTC()
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	return t, oversized, nil
}

func (s *reader) TeamBounded(ctx context.Context, userID, teamID string, limit int) (model.Team, bool, error) {
	return readTeamBounded(ctx, s.tx, userID, teamID, limit)
}

func (s *reader) TeamAccess(ctx context.Context, userID, teamID string) error {
	var owner *string
	var nameNull bool
	var role model.ProjectRole
	err := s.tx.QueryRow(ctx, `SELECT t.personal_user_id::text,t.name IS NULL,m.role FROM teams t
 JOIN team_members m ON m.team_id=t.id WHERE t.id=$1 AND m.user_id=$2`, teamID, userID).Scan(&owner, &nameNull, &role)
	if err != nil {
		return pg.QueryError("read Team", err)
	}
	if (owner != nil && (!nameNull || *owner != userID || role != model.ProjectAdmin)) || (owner == nil && nameNull) {
		return pg.QueryError("read Team", fmt.Errorf("Team membership is invalid"))
	}
	return nil
}

func (s *reader) TeamsBounded(ctx context.Context, userID string, page store.Page, limit int) (store.TeamPage, error) {
	afterTime, afterID := pg.PageValues(page)
	projection := `t.id::text,t.personal_user_id::text,CASE WHEN octet_length(t.name)>$5 THEN '' ELSE t.name END,t.version,t.created_at,t.updated_at,
 m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at`
	rows, err := s.tx.Query(ctx, `SELECT `+projection+`,coalesce(octet_length(t.name)>$5,false) FROM teams t
 JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1
 AND ($2::timestamptz IS NULL OR (t.created_at,t.id)>($2,$3::uuid)) ORDER BY t.created_at,t.id LIMIT $4`, userID, afterTime, afterID, page.Limit+1, limit)
	if err != nil {
		return store.TeamPage{}, pg.QueryError("list Teams", err)
	}
	defer rows.Close()
	result := store.TeamPage{Items: make([]model.Team, 0, page.Limit)}
	for rows.Next() {
		t, oversized, err := scanBoundedTeam(rows)
		if err != nil {
			return store.TeamPage{}, pg.QueryError("list Teams", err)
		}
		if len(result.Items) == page.Limit {
			result.HasMore = true
			break
		}
		if oversized {
			if len(result.Items) == 0 {
				result.Oversized = &t
			}
			result.HasMore = true
			break
		}
		result.Items = append(result.Items, t)
	}
	if err := rows.Err(); err != nil {
		return store.TeamPage{}, pg.QueryError("list Teams", err)
	}
	return result, nil
}

func (s *reader) Teams(ctx context.Context, userID string, page store.Page) (store.TeamPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+teamProjection+` FROM teams t
		JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1
		AND ($2::timestamptz IS NULL OR (t.created_at,t.id)>($2,$3::uuid))
		ORDER BY t.created_at,t.id LIMIT $4`, userID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.TeamPage{}, pg.QueryError("list Teams", err)
	}
	defer rows.Close()
	items := make([]model.Team, 0, page.Limit+1)
	for rows.Next() {
		team, err := scanTeam(rows)
		if err != nil {
			return store.TeamPage{}, pg.QueryError("list Teams", err)
		}
		items = append(items, team)
	}
	if err := rows.Err(); err != nil {
		return store.TeamPage{}, pg.QueryError("list Teams", err)
	}
	more := len(items) > page.Limit
	if more {
		items = items[:page.Limit]
	}
	return store.TeamPage{Items: items, HasMore: more}, nil
}

func (tx *creator) InsertTeam(ctx context.Context, teamID, name string) (model.Team, error) {
	if _, err := tx.tx.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,$2)`, teamID, name); err != nil {
		return model.Team{}, pg.QueryError("create Team", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, tx.userID); err != nil {
		return model.Team{}, pg.QueryError("create Team administrator", err)
	}
	return readTeam(ctx, tx.tx, tx.userID, teamID)
}

func (tx *writer) Team(ctx context.Context, userID string) (model.Team, error) {
	return readTeam(ctx, tx.tx, userID, tx.teamID)
}

func (tx *writer) TeamBounded(ctx context.Context, userID string, limit int) (model.Team, bool, error) {
	return readTeamBounded(ctx, tx.tx, userID, tx.teamID, limit)
}

func (tx *writer) Rename(ctx context.Context, userID, name string) (model.Team, error) {
	if _, err := tx.tx.Exec(ctx, `UPDATE teams SET name=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1`, tx.teamID, name); err != nil {
		return model.Team{}, pg.QueryError("rename Team", err)
	}
	return tx.Team(ctx, userID)
}

func (tx *writer) HasProjects(ctx context.Context) (bool, error) {
	// This separate Read Committed statement observes ownership committed by a
	// writer that held the Team lock before us, without locking its Project.
	var found bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_ownership o JOIN projects p ON p.id=o.project_id
        WHERE o.team_id=$1 AND p.deleted_at IS NULL)`, tx.teamID).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read Team ownership references", err)
	}
	return found, nil
}

func (tx *writer) Delete(ctx context.Context) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM team_invitations WHERE team_id=$1`, tx.teamID); err != nil {
		return pg.QueryError("delete Team invitations", err)
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1`, tx.teamID); err != nil {
		return pg.QueryError("delete Team members", err)
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM teams WHERE id=$1`, tx.teamID); err != nil {
		return pg.QueryError("delete Team", err)
	}
	return nil
}
