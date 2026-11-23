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

type grantReader struct{ tx pgx.Tx }
type grantWriter struct {
	tx            pgx.Tx
	teamID, appID string
}

func NewGrantReader(tx pgx.Tx) store.GitHubGrantReadDAO { return &grantReader{tx} }
func NewGrantWriter(tx pgx.Tx, teamID, appID string) store.GitHubGrantWriteDAO {
	return &grantWriter{tx, teamID, appID}
}

// NewConnectionStopWriter requires the App root to be locked by the caller.
func NewConnectionStopWriter(tx pgx.Tx, appID string) store.GitHubConnectionStopDAO {
	return &grantWriter{tx: tx, appID: appID}
}

func readAdmin(ctx context.Context, tx pgx.Tx, appID, actor string) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `SELECT a.version FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL
 AND EXISTS (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2)`, appID, actor).Scan(&version)
	if err != nil {
		return 0, pg.QueryError("read App administrator", err)
	}
	return version, nil
}

// Locate includes tombstones so a stale confirmation can be rechecked under
// the original Team and App roots without restoring a revoked relationship.
func (r *grantReader) Locate(ctx context.Context, appID, actor, grantID string) (store.GitHubGrantLocation, error) {
	var result store.GitHubGrantLocation
	err := r.tx.QueryRow(ctx, `SELECT a.version,a.impact_version FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2)`, appID, actor).Scan(&result.AppVersion, &result.ImpactVersion)
	if err != nil {
		return result, pg.QueryError("read App administrator", err)
	}
	err = r.tx.QueryRow(ctx, `SELECT team_id::text,revoked_at IS NOT NULL FROM github_app_team_grants WHERE id=$1 AND app_resource_id=$2`, grantID, appID).Scan(&result.TeamID, &result.Revoked)
	if err != nil {
		return result, pg.QueryError("locate grant", err)
	}
	return result, nil
}
func (r *grantReader) GrantVisibility(ctx context.Context, appID, actor, teamID, grantID string, teamOnly bool) error {
	var visible bool
	if teamOnly {
		err := r.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$2 AND m.role='admin' WHERE t.id=$1)`, teamID, actor).Scan(&visible)
		if err != nil {
			return pg.QueryError("check Team administrator", err)
		}
	} else {
		err := r.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2) AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM teams t WHERE t.id=$3)) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM github_app_team_grants g JOIN teams t ON t.id=g.team_id WHERE g.id=$4 AND g.app_resource_id=a.id AND g.revoked_at IS NULL)))`, appID, actor, nullableID(teamID), nullableID(grantID)).Scan(&visible)
		if err != nil {
			return pg.QueryError("check GitHub grant visibility", err)
		}
	}
	if !visible {
		return model.ErrNotFound
	}
	return nil
}

func nullableID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func readTeam(ctx context.Context, tx pgx.Tx, id string) (store.GitHubGrantTeam, error) {
	var t store.GitHubGrantTeam
	var personal, ownerID, ownerName *string
	err := tx.QueryRow(ctx, `SELECT t.id::text,t.name,t.personal_user_id::text,t.version,u.id::text,u.name FROM teams t LEFT JOIN users u ON u.id=t.personal_user_id WHERE t.id=$1`, id).Scan(&t.ID, &t.Name, &personal, &t.Version, &ownerID, &ownerName)
	if err != nil {
		return t, pg.QueryError("read grant Team", err)
	}
	if err = grantTeamOwner(&t, personal, ownerID, ownerName); err != nil {
		return t, pg.QueryError("read grant Team", err)
	}
	return t, nil
}

func grantTeamOwner(t *store.GitHubGrantTeam, personal, ownerID, ownerName *string) error {
	t.Kind = "ordinary"
	if personal != nil {
		if ownerID == nil {
			return fmt.Errorf("personal Team owner is missing")
		}
		t.Kind = "personal"
		t.Name = nil
		t.PersonalOwner = &store.GitHubGrantPersonalOwner{UserID: *ownerID, Name: ownerName}
	}
	return nil
}

const grantProjection = `g.id::text,g.app_resource_id::text,t.id::text,t.name,t.personal_user_id::text,t.version,g.created_at,u.id::text,u.name`
const grantRelation = ` FROM github_app_team_grants g JOIN teams t ON t.id=g.team_id LEFT JOIN users u ON u.id=t.personal_user_id `

func scanGrant(row rowScanner) (store.GitHubTeamGrant, error) {
	var g store.GitHubTeamGrant
	var personal, ownerID, ownerName *string
	err := row.Scan(&g.ID, &g.AppID, &g.Team.ID, &g.Team.Name, &personal, &g.Team.Version, &g.CreatedAt, &ownerID, &ownerName)
	if err != nil {
		return g, err
	}
	if err = grantTeamOwner(&g.Team, personal, ownerID, ownerName); err != nil {
		return g, err
	}
	g.CreatedAt = g.CreatedAt.UTC()
	return g, nil
}
func (r *grantReader) Preview(ctx context.Context, appID, actor, teamID string) (store.GitHubGrantPreview, error) {
	version, err := readAdmin(ctx, r.tx, appID, actor)
	if err != nil {
		return store.GitHubGrantPreview{}, err
	}
	t, err := readTeam(ctx, r.tx, teamID)
	if err != nil {
		return store.GitHubGrantPreview{}, err
	}
	p := store.GitHubGrantPreview{AppID: appID, Version: version, TargetTeam: t}
	g, err := scanGrant(r.tx.QueryRow(ctx, `SELECT `+grantProjection+grantRelation+`WHERE g.app_resource_id=$1 AND g.team_id=$2 AND g.revoked_at IS NULL`, appID, teamID))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return p, pg.QueryError("read current grant", err)
	}
	p.Grant = &g
	return p, nil
}
func (r *grantReader) Grant(ctx context.Context, appID, actor, grantID string) (store.GitHubTeamGrant, error) {
	if _, err := readAdmin(ctx, r.tx, appID, actor); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	g, err := scanGrant(r.tx.QueryRow(ctx, `SELECT `+grantProjection+grantRelation+`WHERE g.app_resource_id=$1 AND g.id=$2 AND g.revoked_at IS NULL`, appID, grantID))
	if err != nil {
		return g, pg.QueryError("read grant", err)
	}
	return g, nil
}
func (r *grantReader) Grants(ctx context.Context, appID, actor string, after *string, limit int) (store.GitHubGrantPage, error) {
	if limit < 1 || limit > 100 {
		return store.GitHubGrantPage{}, fmt.Errorf("grant limit must be 1..100")
	}
	if _, err := readAdmin(ctx, r.tx, appID, actor); err != nil {
		return store.GitHubGrantPage{}, err
	}
	rows, err := r.tx.Query(ctx, `SELECT `+grantProjection+grantRelation+`WHERE g.app_resource_id=$1 AND g.revoked_at IS NULL AND ($2::uuid IS NULL OR g.id>$2) ORDER BY g.id LIMIT $3`, appID, after, limit+1)
	if err != nil {
		return store.GitHubGrantPage{}, pg.QueryError("list grants", err)
	}
	defer rows.Close()
	p := store.GitHubGrantPage{Items: []store.GitHubTeamGrant{}}
	for rows.Next() {
		g, e := scanGrant(rows)
		if e != nil {
			return p, pg.QueryError("scan grant", e)
		}
		p.Items = append(p.Items, g)
	}
	if err = rows.Err(); err != nil {
		return p, pg.QueryError("list grants", err)
	}
	p.HasMore = len(p.Items) > limit
	if p.HasMore {
		p.Items = p.Items[:limit]
	}
	return p, nil
}
func (r *grantReader) TeamApps(ctx context.Context, teamID, actor string, after *string, limit int) (store.GitHubTeamAppPage, error) {
	if limit < 1 || limit > 100 {
		return store.GitHubTeamAppPage{}, fmt.Errorf("Team app limit must be 1..100")
	}
	var id string
	if err := r.tx.QueryRow(ctx, `SELECT t.id::text FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$2 AND m.role='admin' WHERE t.id=$1`, teamID, actor).Scan(&id); err != nil {
		return store.GitHubTeamAppPage{}, pg.QueryError("read Team administrator", err)
	}
	rows, err := r.tx.Query(ctx, `SELECT g.id::text,a.id::text,a.name,a.github_slug,a.github_app_id,a.version,g.created_at FROM github_app_team_grants g JOIN github_apps a ON a.id=g.app_resource_id AND a.deleted_at IS NULL WHERE g.team_id=$1 AND g.revoked_at IS NULL AND ($2::uuid IS NULL OR g.id>$2) ORDER BY g.id LIMIT $3`, teamID, after, limit+1)
	if err != nil {
		return store.GitHubTeamAppPage{}, pg.QueryError("list Team apps", err)
	}
	defer rows.Close()
	p := store.GitHubTeamAppPage{Items: []store.GitHubTeamApp{}}
	for rows.Next() {
		var a store.GitHubTeamApp
		if err = rows.Scan(&a.GrantID, &a.ID, &a.Name, &a.GitHubSlug, &a.GitHubAppID, &a.Version, &a.CreatedAt); err != nil {
			return p, pg.QueryError("scan Team app", err)
		}
		a.CreatedAt = a.CreatedAt.UTC()
		p.Items = append(p.Items, a)
	}
	if err = rows.Err(); err != nil {
		return p, pg.QueryError("list Team apps", err)
	}
	p.HasMore = len(p.Items) > limit
	if p.HasMore {
		p.Items = p.Items[:limit]
	}
	return p, nil
}

// GrantWriteAdmission reads no Team or owner projection before scope admission.
func (w *grantWriter) GrantWriteAdmission(ctx context.Context, actor string) (store.GitHubGrantWriteAdmission, error) {
	var f store.GitHubGrantWriteAdmission
	if err := w.tx.QueryRow(ctx, `SELECT id::text,version FROM teams WHERE id=$1`, w.teamID).Scan(&f.TeamID, &f.TeamVersion); err != nil {
		return f, pg.QueryError("read grant Team authority", err)
	}
	err := w.tx.QueryRow(ctx, `SELECT version,impact_version,EXISTS(SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2) FROM github_apps a WHERE id=$1 AND deleted_at IS NULL`, w.appID, actor).Scan(&f.AppVersion, &f.ImpactVersion, &f.IsAdmin)
	if err != nil {
		return f, pg.QueryError("read grant App authority", err)
	}
	return f, nil
}

func (w *grantWriter) RequireLiveGrant(ctx context.Context, id string) error {
	var found int
	err := w.tx.QueryRow(ctx, `SELECT 1 FROM github_app_team_grants g JOIN teams t ON t.id=g.team_id WHERE g.id=$1 AND g.team_id=$2 AND g.app_resource_id=$3 AND g.revoked_at IS NULL`, id, w.teamID, w.appID).Scan(&found)
	if err != nil {
		return pg.QueryError("check locked grant", err)
	}
	return nil
}

func (w *grantWriter) Facts(ctx context.Context, actor string) (store.GitHubGrantFacts, error) {
	t, err := readTeam(ctx, w.tx, w.teamID)
	if err != nil {
		return store.GitHubGrantFacts{}, err
	}
	f := store.GitHubGrantFacts{Team: t}
	err = w.tx.QueryRow(ctx, `SELECT version,impact_version,EXISTS(SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2) FROM github_apps a WHERE id=$1 AND deleted_at IS NULL`, w.appID, actor).Scan(&f.AppVersion, &f.ImpactVersion, &f.IsAdmin)
	if err != nil {
		return f, pg.QueryError("read grant facts", err)
	}
	return f, nil
}
func (w *grantWriter) Grant(ctx context.Context, id string) (store.GitHubTeamGrant, error) {
	g, err := scanGrant(w.tx.QueryRow(ctx, `SELECT `+grantProjection+grantRelation+`WHERE g.id=$1 AND g.team_id=$2 AND g.app_resource_id=$3 AND g.revoked_at IS NULL`, id, w.teamID, w.appID))
	if err != nil {
		return g, pg.QueryError("read locked grant", err)
	}
	return g, nil
}
func (w *grantWriter) LiveGrant(ctx context.Context) (*store.GitHubTeamGrant, error) {
	g, err := scanGrant(w.tx.QueryRow(ctx, `SELECT `+grantProjection+grantRelation+`WHERE g.team_id=$1 AND g.app_resource_id=$2 AND g.revoked_at IS NULL`, w.teamID, w.appID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read locked grant", err)
	}
	return &g, nil
}
func (w *grantWriter) Insert(ctx context.Context, id string) (store.GitHubTeamGrant, error) {
	_, err := w.tx.Exec(ctx, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, id, w.teamID, w.appID)
	if err != nil {
		var e *pgconn.PgError
		if errors.As(err, &e) && e.Code == "23505" {
			if e.ConstraintName == "github_app_team_grants_pkey" {
				return store.GitHubTeamGrant{}, store.ErrGitHubGrantIDConflict
			}
			if e.ConstraintName == "github_app_team_grants_live" {
				return store.GitHubTeamGrant{}, store.ErrGitHubGrantExists
			}
		}
		return store.GitHubTeamGrant{}, pg.QueryError("insert grant", err)
	}
	return w.Grant(ctx, id)
}
func (w *grantWriter) Revoke(ctx context.Context, id string) error {
	result, err := w.tx.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=statement_timestamp() WHERE id=$1 AND team_id=$2 AND app_resource_id=$3 AND revoked_at IS NULL`, id, w.teamID, w.appID)
	if err != nil {
		return pg.QueryError("revoke grant", err)
	}
	if result.RowsAffected() != 1 {
		return model.ErrNotFound
	}
	return nil
}
func (w *grantWriter) AdvanceImpact(ctx context.Context) error {
	result, err := w.tx.Exec(ctx, `UPDATE github_apps SET impact_version=impact_version+1 WHERE id=$1 AND deleted_at IS NULL AND impact_version<$2`, w.appID, int64(math.MaxInt64))
	if err != nil {
		return pg.QueryError("advance App impact", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
	}
	return nil
}
func (w *grantWriter) StopGrantConnections(ctx context.Context, id string, decision store.GitHubStopDecision) error {
	_, err := w.stopConnections(ctx, id, nil, decision)
	return err
}

func (w *grantWriter) StopAppConnections(ctx context.Context, decision store.GitHubStopDecision) error {
	_, err := w.stopConnections(ctx, nil, nil, decision)
	return err
}

func (w *grantWriter) StopProjectConnection(ctx context.Context, projectID, grantID string, decision store.GitHubStopDecision) (bool, error) {
	count, err := w.stopConnections(ctx, grantID, projectID, decision)
	return count == 1, err
}

func (w *grantWriter) stopConnections(ctx context.Context, grantID, projectID any, decision store.GitHubStopDecision) (int64, error) {
	var exhausted bool
	err := w.tx.QueryRow(ctx, `SELECT COALESCE(bool_or(version=$4 OR generation=$4 OR revision=$4),false) FROM (SELECT version,generation,revision FROM project_github WHERE app_resource_id=$1 AND ($2::uuid IS NULL OR team_grant_id=$2) AND ($3::uuid IS NULL OR project_id=$3) ORDER BY project_id FOR UPDATE) locked`, w.appID, grantID, projectID, int64(math.MaxInt64)).Scan(&exhausted)
	if err != nil {
		return 0, pg.QueryError("lock grant connections", err)
	}
	if exhausted {
		return 0, &model.Fault{Code: "version_exhausted", Message: "GitHub connection version is exhausted."}
	}
	rows, err := w.tx.Query(ctx, `SELECT project_id::text FROM project_github WHERE app_resource_id=$1 AND ($2::uuid IS NULL OR team_grant_id=$2) AND ($3::uuid IS NULL OR project_id=$3) AND sync_enabled ORDER BY project_id`, w.appID, grantID, projectID)
	if err != nil {
		return 0, pg.QueryError("read stopping github coverage", err)
	}
	var projects []string
	for rows.Next() {
		var project string
		if err = rows.Scan(&project); err != nil {
			rows.Close()
			return 0, pg.QueryError("read stopping github coverage", err)
		}
		projects = append(projects, project)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, pg.QueryError("read stopping github coverage", err)
	}
	for _, project := range projects {
		if err = closeConnectionCoverage(ctx, w.tx, project); err != nil {
			return 0, err
		}
	}
	if _, err = w.tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id IN (SELECT project_id FROM project_github WHERE app_resource_id=$1 AND ($2::uuid IS NULL OR team_grant_id=$2) AND ($3::uuid IS NULL OR project_id=$3))`, w.appID, grantID, projectID); err != nil {
		return 0, pg.QueryError("clear grant pending", err)
	}
	result, err := w.tx.Exec(ctx, `UPDATE project_github SET version=version+1,generation=generation+1,revision=revision+1,enabled=$4,sync_enabled=$5,app_id=NULL,installation_id=NULL,app_resource_id=NULL,team_grant_id=NULL,credential_version=NULL,installation_account_login=NULL,access_state=$6,access_reason=NULL,access_checked_at=NULL,next_access_check_at=NULL,next_poll_at=NULL,not_before=NULL,claim_token=NULL,claim_until=NULL,claim_kind=NULL,access_hint_id=NULL,access_delivery_id=NULL,updated_at=statement_timestamp() WHERE app_resource_id=$1 AND ($2::uuid IS NULL OR team_grant_id=$2) AND ($3::uuid IS NULL OR project_id=$3)`, w.appID, grantID, projectID, decision.Enabled, decision.SyncEnabled, decision.AccessState)
	if err != nil {
		return 0, pg.QueryError("stop grant connections", err)
	}
	return result.RowsAffected(), nil
}
