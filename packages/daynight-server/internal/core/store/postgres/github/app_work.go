package github

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const appWorkJoins = `FROM project_github g
 JOIN projects p ON p.id=g.project_id
 JOIN project_ownership o ON o.project_id=p.id
 JOIN teams t ON t.id=o.team_id
 JOIN github_apps a ON a.id=g.app_resource_id
 JOIN github_app_team_grants r ON r.id=g.team_grant_id`

const appWorkAuthorization = `p.deleted_at IS NULL AND a.deleted_at IS NULL AND r.revoked_at IS NULL
 AND r.app_resource_id=a.id AND r.team_id=o.team_id
 AND g.app_id=a.github_app_id AND g.credential_version=a.credential_version
 AND g.enabled AND g.sync_enabled AND g.installation_id IS NOT NULL AND g.repository_id IS NOT NULL`

type appWorkWriter struct {
	sql      *writer
	identity store.GitHubAppWorkIdentity
}

// NewAppWorkWriter freezes authorization roots before the connection. App-wide
// invalidation takes App then connection locks and never needs Project or Team,
// so it can wait for this transaction without a reverse lock edge.
func NewAppWorkWriter(ctx context.Context, tx pgx.Tx, projectID string, expected *store.GitHubAppWorkIdentity) (store.GitHubAppWorkDAO, error) {
	var id, teamID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, projectID).Scan(&id); err != nil {
		return nil, appWorkError("lock github work Project", err)
	}
	if err := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR SHARE`, projectID).Scan(&teamID); err != nil {
		return nil, pg.QueryError("lock github work ownership", err)
	}
	if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, teamID).Scan(&id); err != nil {
		return nil, pg.QueryError("lock github work Team", err)
	}
	var appID, grantID string
	if err := tx.QueryRow(ctx, `SELECT app_resource_id::text,team_grant_id::text FROM project_github WHERE project_id=$1 AND enabled AND sync_enabled AND app_resource_id IS NOT NULL AND team_grant_id IS NOT NULL`, projectID).Scan(&appID, &grantID); err != nil {
		return nil, appWorkError("read github work binding", err)
	}
	if err := tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, appID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var referenced bool
			if readErr := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_github WHERE project_id=$1 AND app_resource_id=$2 AND enabled)`, projectID, appID).Scan(&referenced); readErr != nil {
				return nil, pg.QueryError("recheck github work App reference", readErr)
			}
			if referenced {
				return nil, fmt.Errorf("github work connection references a missing live App: %w", err)
			}
		}
		return nil, appWorkError("lock github work App", err)
	}
	if err := tx.QueryRow(ctx, `SELECT id::text FROM github_app_team_grants WHERE id=$1 AND app_resource_id=$2 AND team_id=$3 AND revoked_at IS NULL FOR SHARE`, grantID, appID, teamID).Scan(&id); err != nil {
		return nil, appWorkError("lock github work grant", err)
	}
	w := &appWorkWriter{sql: &writer{tx: tx, projectID: projectID}}
	if _, err := w.sql.Connection(ctx); err != nil {
		return nil, err
	}
	err := tx.QueryRow(ctx, `SELECT a.id::text,r.id::text,o.team_id::text,a.github_app_id,a.credential_version,o.version `+appWorkJoins+` WHERE g.project_id=$1 AND `+appWorkAuthorization, projectID).
		Scan(&w.identity.AppResourceID, &w.identity.GrantID, &w.identity.TeamID, &w.identity.AppID, &w.identity.CredentialVersion, &w.identity.OwnershipVersion)
	if err != nil {
		return nil, appWorkError("read github work authorization", err)
	}
	if expected != nil && *expected != w.identity {
		return nil, store.ErrGitHubAppWorkUnavailable
	}
	return w, nil
}

func appWorkError(phase string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return store.ErrGitHubAppWorkUnavailable
	}
	return pg.QueryError(phase, err)
}

func (w *appWorkWriter) Identity() store.GitHubAppWorkIdentity { return w.identity }

func (w *appWorkWriter) authorized(ctx context.Context) (bool, error) {
	i := w.identity
	var valid bool
	err := w.sql.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 `+appWorkJoins+` WHERE g.project_id=$1 AND `+appWorkAuthorization+`
 AND a.id=$2 AND a.credential_version=$3 AND r.id=$4 AND o.team_id=$5 AND a.github_app_id=$6 AND o.version=$7)`,
		w.sql.projectID, i.AppResourceID, i.CredentialVersion, i.GrantID, i.TeamID, i.AppID, i.OwnershipVersion).Scan(&valid)
	if err != nil {
		return false, pg.QueryError("check github App work authorization", err)
	}
	return valid, nil
}

func (w *appWorkWriter) Connection(ctx context.Context) (githubpr.Connection, error) {
	valid, err := w.authorized(ctx)
	if err != nil {
		return githubpr.Connection{}, err
	}
	if !valid {
		return githubpr.Connection{}, store.ErrGitHubAppWorkUnavailable
	}
	return w.sql.Connection(ctx)
}

func (w *appWorkWriter) ObservedAt(ctx context.Context) (time.Time, error) {
	return w.sql.ObservedAt(ctx)
}

func (w *appWorkWriter) Claim(ctx context.Context, claim store.GitHubClaim) (bool, error) {
	valid, err := w.authorized(ctx)
	if err != nil || !valid || claim.AppID != w.identity.AppID {
		return false, err
	}
	return w.sql.Claim(ctx, claim)
}

func (w *appWorkWriter) ValidLease(ctx context.Context, lease store.GitHubLease) (bool, error) {
	valid, err := w.authorized(ctx)
	if err != nil || !valid {
		return false, err
	}
	return w.sql.ValidLease(ctx, lease)
}

func (w *appWorkWriter) Renew(ctx context.Context, lease store.GitHubLease, until time.Time) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.Renew(ctx, lease, until)
}

func (w *appWorkWriter) Publish(ctx context.Context, lease store.GitHubLease, items []githubpr.PullRequest) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.Publish(ctx, lease, items)
}

func (w *appWorkWriter) PublicationFacts(ctx context.Context, lease store.GitHubLease, repositoryID, number int64, terminalAt *time.Time) (store.GitHubPublicationFacts, bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return store.GitHubPublicationFacts{}, false, err
	}
	return w.sql.PublicationFacts(ctx, lease, repositoryID, number, terminalAt)
}

func (w *appWorkWriter) PublishRepository(ctx context.Context, lease store.GitHubLease, observation store.GitHubRepositoryObservation) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.PublishRepository(ctx, lease, observation)
}

func (w *appWorkWriter) UnseenActive(ctx context.Context, lease store.GitHubLease, pollID string, after int64, limit int) ([]int64, bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return nil, false, err
	}
	return w.sql.UnseenActive(ctx, lease, pollID, after, limit)
}

func (w *appWorkWriter) Pending(ctx context.Context, lease store.GitHubLease, now time.Time, limit int) ([]store.GitHubPendingPR, bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return nil, false, err
	}
	return w.sql.Pending(ctx, lease, now, limit)
}

func (w *appWorkWriter) HasPending(ctx context.Context, lease store.GitHubLease) (bool, bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, false, err
	}
	return w.sql.HasPending(ctx, lease)
}

func (w *appWorkWriter) HasDuePending(ctx context.Context, now time.Time) (bool, error) {
	if valid, err := w.authorized(ctx); err != nil || !valid {
		return false, err
	}
	return w.sql.HasDuePending(ctx, now)
}

func (w *appWorkWriter) AckPending(ctx context.Context, lease store.GitHubLease, number int64, request string) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.AckPending(ctx, lease, number, request)
}

func (w *appWorkWriter) ReschedulePending(ctx context.Context, lease store.GitHubLease, number int64, request string, next time.Time) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.ReschedulePending(ctx, lease, number, request, next)
}

func (w *appWorkWriter) AckAccessHint(ctx context.Context, lease store.GitHubLease, hint string) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.AckAccessHint(ctx, lease, hint)
}

func (w *appWorkWriter) SaveRuntime(ctx context.Context, lease store.GitHubLease, runtime store.GitHubRuntimeWrite) (bool, error) {
	if valid, err := w.ValidLease(ctx, lease); err != nil || !valid {
		return false, err
	}
	return w.sql.SaveRuntime(ctx, lease, runtime)
}
