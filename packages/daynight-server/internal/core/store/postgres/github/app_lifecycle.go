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
	"github.com/jackc/pgx/v5/pgconn"
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

func NewRepositorySwitch(tx pgx.Tx, id string) store.GitHubRepositorySwitchDAO {
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

// SaveSwitch applies the core's complete disconnected state. The old coverage
// boundary is captured while the old repository identity is still locked.
func (d *projectRetirement) SaveSwitch(ctx context.Context, w store.GitHubRepositorySwitchWrite) (bool, error) {
	if !d.locked {
		return false, errors.New("switching connection has not been locked")
	}
	if d.exists {
		if err := closeConnectionCoverage(ctx, d.tx, d.id); err != nil {
			return false, err
		}
	}
	if _, err := d.tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id=$1`, d.id); err != nil {
		return false, pg.QueryError("clear switching connection pending", err)
	}
	c := w.Connection
	args := []any{d.id, c.Version, c.Generation, c.Revision, c.Enabled, c.SyncEnabled,
		c.AppID, c.InstallationID, c.RepositoryID, c.LegacyRepositoryID, c.InstallationAccountLogin,
		c.RepositoryFullName, c.RepositoryPrivate, c.PollIntervalMinutes, c.AccessState, c.AccessReason,
		c.AccessCheckedAt, c.NextAccessCheckAt, c.AccessHintID, c.AccessDeliveryID, c.NextPollAt,
		c.NotBefore, c.LastPollAttemptAt, c.LastFullSuccessAt, c.LastFullGeneration, c.PollErrorCode,
		c.PollErrorMessage, c.PollErrorAt, c.LastWebhookReceivedAt, c.LastWebhookAttemptAt,
		c.LastWebhookSuccessAt, c.WebhookErrorCode, c.WebhookErrorMessage, c.WebhookErrorAt,
		c.ClaimToken, c.ClaimUntil, c.ClaimKind, w.AppResourceID, w.GrantID, w.CredentialVersion}
	var result pgconn.CommandTag
	var err error
	if d.exists {
		args = append(args, w.ExpectedVersion, w.ExpectedGeneration, w.ExpectedRevision)
		result, err = d.tx.Exec(ctx, `UPDATE project_github SET version=$2,generation=$3,revision=$4,enabled=$5,sync_enabled=$6,
            app_id=$7,installation_id=$8,repository_id=$9,legacy_repository_id=$10,installation_account_login=$11,
			repository_default_branch=CASE WHEN repository_id IS DISTINCT FROM $9 THEN NULL ELSE repository_default_branch END,
            repository_full_name=$12,repository_private=$13,poll_interval_minutes=$14,access_state=$15,access_reason=$16,
            access_checked_at=$17,next_access_check_at=$18,access_hint_id=$19,access_delivery_id=$20,next_poll_at=$21,
            not_before=$22,last_poll_attempt_at=$23,last_full_success_at=$24,last_full_generation=$25,poll_error_code=$26,
            poll_error_message=$27,poll_error_at=$28,last_webhook_received_at=$29,last_webhook_attempt_at=$30,
            last_webhook_success_at=$31,webhook_error_code=$32,webhook_error_message=$33,webhook_error_at=$34,
            claim_token=$35,claim_until=$36,claim_kind=$37,app_resource_id=$38,team_grant_id=$39,credential_version=$40,
            updated_at=statement_timestamp() WHERE project_id=$1 AND version=$41 AND generation=$42 AND revision=$43`, args...)
	} else {
		result, err = d.tx.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,
            app_id,installation_id,repository_id,legacy_repository_id,installation_account_login,repository_full_name,repository_private,
            poll_interval_minutes,access_state,access_reason,access_checked_at,next_access_check_at,access_hint_id,access_delivery_id,
            next_poll_at,not_before,last_poll_attempt_at,last_full_success_at,last_full_generation,poll_error_code,poll_error_message,
            poll_error_at,last_webhook_received_at,last_webhook_attempt_at,last_webhook_success_at,webhook_error_code,webhook_error_message,
            webhook_error_at,claim_token,claim_until,claim_kind,app_resource_id,team_grant_id,credential_version)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
            ON CONFLICT(project_id) DO NOTHING`, args...)
	}
	if err != nil {
		return false, pg.QueryError("save switching connection", err)
	}
	if result.RowsAffected() != 1 {
		return false, nil
	}
	if w.Source != nil {
		if _, err = d.tx.Exec(ctx, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,$2,$3)
 ON CONFLICT(project_id,repository_id) DO UPDATE SET full_name=EXCLUDED.full_name`, d.id, w.Source.RepositoryID, w.Source.FullName); err != nil {
			return false, pg.QueryError("save switching repository source", err)
		}
	}
	return true, nil
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
