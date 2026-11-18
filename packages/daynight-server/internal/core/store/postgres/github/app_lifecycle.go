package github

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type projectRetirement struct {
	tx             pgx.Tx
	id             string
	appID          *string
	exists, locked bool
}

func NewProjectRetirement(tx pgx.Tx, id string) store.GitHubProjectRetirementDAO {
	return &projectRetirement{tx: tx, id: id}
}

func (d *projectRetirement) LockBinding(ctx context.Context) (*string, error) {
	var candidate, grant *string
	err := d.tx.QueryRow(ctx, `SELECT app_resource_id::text,team_grant_id::text FROM project_github WHERE project_id=$1`, d.id).Scan(&candidate, &grant)
	if errors.Is(err, pgx.ErrNoRows) {
		d.locked = true
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("locate retiring connection", err)
	}
	var appDeleted bool
	if candidate != nil {
		err = d.tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM github_apps WHERE id=$1 FOR UPDATE`, *candidate).Scan(&appDeleted)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, pg.QueryError("lock retiring App", err)
		}
		appDeleted = appDeleted || errors.Is(err, pgx.ErrNoRows)
		if grant != nil {
			var id string
			if err := d.tx.QueryRow(ctx, `SELECT id::text FROM github_app_team_grants WHERE id=$1 FOR UPDATE`, *grant).Scan(&id); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, pg.QueryError("lock retiring grant", err)
			}
		}
	}
	// App cleanup can finish while its root lock is awaited. A fresh statement
	// must observe that cleanup before the old candidate is interpreted.
	var current, currentGrant *string
	err = d.tx.QueryRow(ctx, `SELECT app_resource_id::text,team_grant_id::text FROM project_github WHERE project_id=$1 FOR UPDATE`, d.id).Scan(&current, &currentGrant)
	if err != nil {
		return nil, pg.QueryError("lock retiring connection", err)
	}
	if current != nil {
		if candidate == nil || *current != *candidate || appDeleted || currentGrant == nil {
			return nil, fmt.Errorf("retiring connection references an unavailable App or grant")
		}
		var valid bool
		if err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_app_team_grants WHERE id=$1 AND app_resource_id=$2 AND revoked_at IS NULL)`, *currentGrant, *current).Scan(&valid); err != nil {
			return nil, pg.QueryError("read retiring grant", err)
		}
		if !valid {
			return nil, fmt.Errorf("retiring connection references an unavailable grant")
		}
	} else if currentGrant != nil {
		return nil, fmt.Errorf("retiring connection grant has no App")
	}
	d.appID, d.exists, d.locked = current, true, true
	return current, nil
}
func (d *projectRetirement) Stop(ctx context.Context, v store.GitHubStopDecision) error {
	if !d.locked {
		return errors.New("retiring connection has not been locked")
	}
	if !d.exists {
		return nil
	}
	if d.appID != nil {
		var grant string
		if err := d.tx.QueryRow(ctx, `SELECT team_grant_id::text FROM project_github WHERE project_id=$1`, d.id).Scan(&grant); err != nil {
			return pg.QueryError("read retiring connection grant", err)
		}
		stopped, err := NewConnectionStopWriter(d.tx, *d.appID).StopProjectConnection(ctx, d.id, grant, v)
		if err != nil {
			return err
		}
		if !stopped {
			return errors.New("retiring connection was not stopped")
		}
		return nil
	}
	var exhausted bool
	if err := d.tx.QueryRow(ctx, `SELECT (enabled OR sync_enabled) AND (version=$2 OR generation=$2 OR revision=$2) FROM project_github WHERE project_id=$1`, d.id, int64(math.MaxInt64)).Scan(&exhausted); err != nil {
		return pg.QueryError("read unbound retirement versions", err)
	}
	if exhausted {
		return &model.Fault{Code: "version_exhausted", Message: "GitHub connection version is exhausted."}
	}
	if err := closeConnectionCoverage(ctx, d.tx, d.id); err != nil {
		return err
	}
	if _, err := d.tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id=$1`, d.id); err != nil {
		return pg.QueryError("clear unbound retirement pending", err)
	}
	_, err := d.tx.Exec(ctx, `UPDATE project_github SET version=version+1,generation=generation+1,revision=revision+1,enabled=$2,sync_enabled=$3,app_id=NULL,installation_id=NULL,credential_version=NULL,installation_account_login=NULL,access_state=$4,access_reason=NULL,access_checked_at=NULL,next_access_check_at=NULL,next_poll_at=NULL,not_before=NULL,claim_token=NULL,claim_until=NULL,claim_kind=NULL,access_hint_id=NULL,access_delivery_id=NULL,updated_at=statement_timestamp() WHERE project_id=$1 AND (enabled OR sync_enabled)`, d.id, v.Enabled, v.SyncEnabled, v.AccessState)
	if err != nil {
		return pg.QueryError("stop unbound retiring connection", err)
	}
	return nil
}
func (d *projectRetirement) AdvanceImpact(ctx context.Context) error {
	if !d.locked {
		return errors.New("retiring connection has not been locked")
	}
	if d.appID == nil {
		return nil
	}
	return NewConnectionStopWriter(d.tx, *d.appID).AdvanceImpact(ctx)
}

type teamRetirement struct {
	tx pgx.Tx
	id string
}

func NewTeamRetirement(tx pgx.Tx, id string) store.GitHubTeamRetirementDAO {
	return &teamRetirement{tx, id}
}
func (d *teamRetirement) LockGrants(ctx context.Context) ([]store.GitHubTeamRetirementGrant, error) {
	rows, err := d.tx.Query(ctx, `SELECT DISTINCT app_resource_id::text FROM github_app_team_grants WHERE team_id=$1 AND revoked_at IS NULL ORDER BY app_resource_id::text`, d.id)
	if err != nil {
		return nil, pg.QueryError("locate Team grant Apps", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, pg.QueryError("scan Team grant Apps", err)
	}
	for _, id := range ids {
		var locked string
		if err = d.tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, pg.QueryError("lock Team grant App", err)
		}
	}
	rows, err = d.tx.Query(ctx, `SELECT g.id::text,g.app_resource_id::text,a.id IS NULL OR a.deleted_at IS NOT NULL FROM github_app_team_grants g LEFT JOIN github_apps a ON a.id=g.app_resource_id WHERE g.team_id=$1 AND g.revoked_at IS NULL ORDER BY g.id FOR UPDATE OF g`, d.id)
	if err != nil {
		return nil, pg.QueryError("lock retiring Team grants", err)
	}
	defer rows.Close()
	grants := []store.GitHubTeamRetirementGrant{}
	for rows.Next() {
		var g store.GitHubTeamRetirementGrant
		var unavailable bool
		if err = rows.Scan(&g.ID, &g.AppID, &unavailable); err != nil {
			return nil, pg.QueryError("scan retiring Team grants", err)
		}
		if unavailable {
			return nil, errors.New("current Team grant references an unavailable App")
		}
		grants = append(grants, g)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read retiring Team grants", err)
	}
	return grants, nil
}
func (d *teamRetirement) StopGrant(ctx context.Context, g store.GitHubTeamRetirementGrant, v store.GitHubStopDecision) error {
	return NewConnectionStopWriter(d.tx, g.AppID).StopGrantConnections(ctx, g.ID, v)
}
func (d *teamRetirement) RevokeGrant(ctx context.Context, g store.GitHubTeamRetirementGrant) error {
	return NewGrantWriter(d.tx, d.id, g.AppID).Revoke(ctx, g.ID)
}
func (d *teamRetirement) AdvanceImpact(ctx context.Context, g store.GitHubTeamRetirementGrant) error {
	return NewConnectionStopWriter(d.tx, g.AppID).AdvanceImpact(ctx)
}
