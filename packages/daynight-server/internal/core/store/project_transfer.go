package store

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

// TransferTeam is the minimal Team metadata needed to confirm a transfer.
type TransferTeam struct {
	Ref     core.TeamRef
	Version int64
}

func readTransferTeam(ctx context.Context, tx pgx.Tx, id, lock string) (TransferTeam, error) {
	var result TransferTeam
	var personal *string
	err := tx.QueryRow(ctx, `SELECT id::text,name,personal_user_id::text,version FROM teams WHERE id=$1`+lock, id).Scan(&result.Ref.ID, &result.Ref.Name, &personal, &result.Version)
	if err != nil {
		return TransferTeam{}, queryError("read transfer Team", err)
	}
	result.Ref.Kind = "ordinary"
	if personal != nil {
		result.Ref.Kind = "personal"
		if result.Ref.Name != nil {
			return TransferTeam{}, fmt.Errorf("Personal Team has a name")
		}
	} else if result.Ref.Name == nil {
		return TransferTeam{}, fmt.Errorf("ordinary Team name is missing")
	}
	return result, nil
}

func (s *Snapshot) TransferTeam(ctx context.Context, id string) (TransferTeam, error) {
	return readTransferTeam(ctx, s.tx, id, "")
}

func (s *Snapshot) TransferRole(ctx context.Context, userID, projectID, teamID string) (*core.ProjectRole, error) {
	var role *core.ProjectRole
	err := s.tx.QueryRow(ctx, `SELECT CASE WHEN bool_or(role='admin') THEN 'admin' ELSE 'member' END FROM (SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 UNION ALL SELECT role FROM project_grants WHERE project_id=$3 AND user_id=$2) sources HAVING count(*)>0`, teamID, userID, projectID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, queryError("read transfer role", err)
	}
	return role, nil
}

func (tx *ProjectTx) LockTransferOwnership(ctx context.Context) (core.ProjectOwnership, error) {
	var ownership core.ProjectOwnership
	err := tx.tx.QueryRow(ctx, `SELECT team_id::text,version,updated_at FROM project_ownership WHERE project_id=$1 FOR UPDATE`, tx.projectID).Scan(&ownership.TeamID, &ownership.Version, &ownership.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return core.ProjectOwnership{}, fmt.Errorf("project ownership is missing")
	}
	if err != nil {
		return core.ProjectOwnership{}, queryError("lock transfer ownership", err)
	}
	return ownership, nil
}

func (tx *ProjectTx) LockTransferTeams(ctx context.Context, sourceID, targetID string) (TransferTeam, TransferTeam, error) {
	ids := []string{sourceID}
	if targetID != sourceID {
		ids = append(ids, targetID)
	}
	sort.Strings(ids)
	teams := make(map[string]TransferTeam, len(ids))
	missing := make(map[string]bool)
	for _, id := range ids {
		team, err := readTransferTeam(ctx, tx.tx, id, " FOR UPDATE")
		if errors.Is(err, core.ErrNotFound) {
			missing[id] = true
			continue
		}
		if err != nil {
			return TransferTeam{}, TransferTeam{}, err
		}
		teams[id] = team
	}
	if missing[sourceID] {
		return TransferTeam{}, TransferTeam{}, fmt.Errorf("project owner Team is missing")
	}
	// An absent destination is reported only after source authority is checked.
	return teams[sourceID], teams[targetID], nil
}

func (tx *ProjectTx) MoveOwnership(ctx context.Context, targetID string) (core.ProjectOwnership, error) {
	var result core.ProjectOwnership
	err := tx.tx.QueryRow(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1,updated_at=statement_timestamp() WHERE project_id=$1 RETURNING team_id::text,version,updated_at`, tx.projectID, targetID).Scan(&result.TeamID, &result.Version, &result.UpdatedAt)
	if err != nil {
		return core.ProjectOwnership{}, queryError("update project ownership", err)
	}
	if _, err = tx.tx.Exec(ctx, `UPDATE projects SET updated_at=statement_timestamp() WHERE id=$1`, tx.projectID); err != nil {
		return core.ProjectOwnership{}, queryError("update transferred project", err)
	}
	return result, nil
}
