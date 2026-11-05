package store

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

const teamProjection = `t.id::text,t.personal_user_id::text,t.name,t.version,t.created_at,t.updated_at,
	m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at`

type TeamPage struct {
	Items   []model.Team
	HasMore bool
}

type TeamTx struct {
	tx     pgx.Tx
	teamID string
}

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
		return model.Team{}, queryError("read Team", err)
	}
	return team, nil
}

func (s *Snapshot) Team(ctx context.Context, userID, teamID string) (model.Team, error) {
	return readTeam(ctx, s.tx, userID, teamID)
}

func (s *Snapshot) Teams(ctx context.Context, userID string, page Page) (TeamPage, error) {
	afterTime, afterID := pageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+teamProjection+` FROM teams t
		JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1
		AND ($2::timestamptz IS NULL OR (t.created_at,t.id)>($2,$3::uuid))
		ORDER BY t.created_at,t.id LIMIT $4`, userID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return TeamPage{}, queryError("list Teams", err)
	}
	defer rows.Close()
	items := make([]model.Team, 0, page.Limit+1)
	for rows.Next() {
		team, err := scanTeam(rows)
		if err != nil {
			return TeamPage{}, queryError("list Teams", err)
		}
		items = append(items, team)
	}
	if err := rows.Err(); err != nil {
		return TeamPage{}, queryError("list Teams", err)
	}
	more := len(items) > page.Limit
	if more {
		items = items[:page.Limit]
	}
	return TeamPage{Items: items, HasMore: more}, nil
}

func (s *Store) CreateTeam(ctx context.Context, userID, teamID, name string) (model.Team, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return model.Team{}, queryError("begin Team creation", err)
	}
	var team model.Team
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var user string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR KEY SHARE`, userID).Scan(&user); err != nil {
			return queryError("read Team creator", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,$2)`, teamID, name); err != nil {
			return queryError("create Team", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, userID); err != nil {
			return queryError("create Team administrator", err)
		}
		team, err = readTeam(ctx, tx, userID, teamID)
		return err
	})
	if err != nil {
		return model.Team{}, queryError("create Team", err)
	}
	return team, nil
}

func (s *Store) WriteTeam(ctx context.Context, teamID string, operation func(*TeamTx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return queryError("begin Team write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, teamID).Scan(&id); err != nil {
			return queryError("lock Team", err)
		}
		return operation(&TeamTx{tx: tx, teamID: teamID})
	})
	if err != nil {
		return queryError("write Team", err)
	}
	return nil
}

func (tx *TeamTx) Team(ctx context.Context, userID string) (model.Team, error) {
	return readTeam(ctx, tx.tx, userID, tx.teamID)
}

func (tx *TeamTx) Rename(ctx context.Context, userID, name string) (model.Team, error) {
	if _, err := tx.tx.Exec(ctx, `UPDATE teams SET name=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1`, tx.teamID, name); err != nil {
		return model.Team{}, queryError("rename Team", err)
	}
	return tx.Team(ctx, userID)
}

func (tx *TeamTx) HasProjects(ctx context.Context) (bool, error) {
	// This separate Read Committed statement observes ownership committed by a
	// writer that held the Team lock before us, without locking its Project.
	var found bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_ownership WHERE team_id=$1)`, tx.teamID).Scan(&found)
	if err != nil {
		return false, queryError("read Team ownership references", err)
	}
	return found, nil
}

func (tx *TeamTx) Delete(ctx context.Context) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM team_invitations WHERE team_id=$1`, tx.teamID); err != nil {
		return queryError("delete Team invitations", err)
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1`, tx.teamID); err != nil {
		return queryError("delete Team members", err)
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM teams WHERE id=$1`, tx.teamID); err != nil {
		return queryError("delete Team", err)
	}
	return nil
}
