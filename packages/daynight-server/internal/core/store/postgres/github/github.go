// Package github implements the GitHub resource DAO over PostgreSQL.
package github

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type reader struct{ tx pgx.Tx }
type writer struct {
	tx        pgx.Tx
	projectID string
}

func NewReader(tx pgx.Tx) store.GitHubReadDAO { return &reader{tx: tx} }
func NewWriter(tx pgx.Tx, projectID string) store.GitHubWriteDAO {
	return &writer{tx: tx, projectID: projectID}
}

const connectionFields = `project_id::text, version, generation, revision, enabled, sync_enabled,
 app_id, installation_id, repository_id, installation_account_login, repository_full_name, repository_private,
 poll_interval_minutes, access_state, access_reason, access_checked_at, next_access_check_at,
 access_hint_id::text, access_delivery_id, next_poll_at, not_before, last_poll_attempt_at,
 last_full_success_at, last_full_generation, poll_error_code, poll_error_message, poll_error_at,
 last_webhook_received_at, last_webhook_attempt_at, last_webhook_success_at,
 webhook_error_code, webhook_error_message, webhook_error_at, claim_token::text, claim_until,
 claim_kind, created_at, updated_at`

type rowScanner interface{ Scan(...any) error }

func scanConnection(row rowScanner) (githubpr.Connection, error) {
	var c githubpr.Connection
	err := row.Scan(&c.ProjectID, &c.Version, &c.Generation, &c.Revision, &c.Enabled, &c.SyncEnabled,
		&c.AppID, &c.InstallationID, &c.RepositoryID, &c.InstallationAccountLogin, &c.RepositoryFullName, &c.RepositoryPrivate,
		&c.PollIntervalMinutes, &c.AccessState, &c.AccessReason, &c.AccessCheckedAt, &c.NextAccessCheckAt,
		&c.AccessHintID, &c.AccessDeliveryID, &c.NextPollAt, &c.NotBefore, &c.LastPollAttemptAt,
		&c.LastFullSuccessAt, &c.LastFullGeneration, &c.PollErrorCode, &c.PollErrorMessage, &c.PollErrorAt,
		&c.LastWebhookReceivedAt, &c.LastWebhookAttemptAt, &c.LastWebhookSuccessAt,
		&c.WebhookErrorCode, &c.WebhookErrorMessage, &c.WebhookErrorAt, &c.ClaimToken, &c.ClaimUntil,
		&c.ClaimKind, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func readConnection(ctx context.Context, tx pgx.Tx, id string, lock bool) (githubpr.Connection, error) {
	query := `SELECT ` + connectionFields + ` FROM project_github WHERE project_id=$1`
	if lock {
		// Broadcast writes do not acquire the Project lock. Lock this row after
		// the Project row so their facts remain stable until management commits.
		query += ` FOR UPDATE`
	}
	c, err := scanConnection(tx.QueryRow(ctx, query, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return githubpr.DefaultConnection(id), nil
	}
	if err != nil {
		return githubpr.Connection{}, pg.QueryError("read github connection", err)
	}
	return c, nil
}
func (r *reader) Connection(ctx context.Context, id string) (githubpr.Connection, error) {
	return readConnection(ctx, r.tx, id, false)
}
func (w *writer) Connection(ctx context.Context) (githubpr.Connection, error) {
	return readConnection(ctx, w.tx, w.projectID, true)
}

func (w *writer) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := w.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&observed); err != nil {
		return time.Time{}, pg.QueryError("read github project clock", err)
	}
	return observed, nil
}

func (w *writer) SaveConfiguration(ctx context.Context, c store.GitHubConfigurationWrite) (bool, error) {
	args := []any{w.projectID, c.Version, c.Generation, c.Revision, c.Enabled, c.AppID, c.InstallationID, c.RepositoryID,
		c.InstallationAccountLogin, c.RepositoryFullName, c.RepositoryPrivate, c.PollIntervalMinutes, c.AccessState,
		c.AccessReason, c.AccessCheckedAt, c.NextAccessCheckAt, c.NextPollAt, c.ExpectedVersion, c.SyncEnabled}
	var sql string
	if c.ExpectedVersion == 1 {
		sql = `INSERT INTO project_github (project_id, version, generation, revision, enabled, app_id, installation_id,
		 repository_id, installation_account_login, repository_full_name, repository_private, poll_interval_minutes,
		 access_state, access_reason, access_checked_at, next_access_check_at, next_poll_at, sync_enabled)
		 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19 WHERE $18::bigint=1
		 ON CONFLICT (project_id) DO NOTHING`
	} else {
		sql = `UPDATE project_github SET version=$2, generation=$3, revision=$4, enabled=$5, app_id=$6,
		 installation_id=$7, repository_id=$8, installation_account_login=$9, repository_full_name=$10,
		 repository_private=$11, poll_interval_minutes=$12, access_state=$13, access_reason=$14,
		 access_checked_at=$15, next_access_check_at=$16, next_poll_at=$17, sync_enabled=$19,
         claim_token=CASE WHEN generation<>$3 THEN NULL ELSE claim_token END,
         claim_until=CASE WHEN generation<>$3 THEN NULL ELSE claim_until END,
         claim_kind=CASE WHEN generation<>$3 THEN NULL ELSE claim_kind END,
         access_hint_id=CASE WHEN generation<>$3 THEN NULL ELSE access_hint_id END,
         access_delivery_id=CASE WHEN generation<>$3 THEN NULL ELSE access_delivery_id END,
         updated_at=statement_timestamp()
		 WHERE project_id=$1 AND version=$18`
	}
	result, err := w.tx.Exec(ctx, sql, args...)
	if err != nil {
		return false, pg.QueryError("save github configuration", err)
	}
	if result.RowsAffected() != 1 {
		return false, nil
	}
	// The Project and connection locks precede pending-row deletion. Keeping
	// only this generation makes management writes and signals serialize.
	if _, err := w.tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id=$1 AND generation<>$2`, w.projectID, c.Generation); err != nil {
		return false, pg.QueryError("clear old github pending requests", err)
	}
	return true, nil
}

const summaryFields = `project_id::text, number, github_id, url, title, author_id, author_login,
 state, draft, base_ref, head_repository_id, head_repository_full_name, head_ref, head_sha,
 github_created_at, github_updated_at, github_closed_at, github_merged_at, observed_at, revision, seen_poll_id::text`

func summaryTargets(p *githubpr.PullRequestSummary) []any {
	return []any{&p.ProjectID, &p.Number, &p.GitHubID, &p.URL, &p.Title, &p.AuthorID, &p.AuthorLogin,
		&p.State, &p.Draft, &p.BaseRef, &p.HeadRepositoryID, &p.HeadRepositoryFullName, &p.HeadRef, &p.HeadSHA,
		&p.GitHubCreatedAt, &p.GitHubUpdatedAt, &p.GitHubClosedAt, &p.GitHubMergedAt, &p.ObservedAt, &p.Revision, &p.SeenPollID}
}
func (r *reader) Bindings(ctx context.Context, q store.GitHubBindingsQuery) ([]githubpr.Connection, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return nil, fmt.Errorf("github binding limit must be 1..100")
	}
	rows, err := r.tx.Query(ctx, `SELECT `+connectionFields+` FROM project_github g
 WHERE app_id=$1 AND installation_id=$2 AND ($3::bigint IS NULL OR repository_id=$3)
 AND ($4::uuid IS NULL OR project_id>$4) AND EXISTS
 (SELECT 1 FROM projects p WHERE p.id=g.project_id AND p.deleted_at IS NULL)
 ORDER BY project_id LIMIT $5`, q.AppID, q.InstallationID, q.RepositoryID, q.AfterProjectID, q.Limit)
	if err != nil {
		return nil, pg.QueryError("read github bindings", err)
	}
	defer rows.Close()
	out := []githubpr.Connection{}
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			return nil, pg.QueryError("read github bindings", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read github bindings", err)
	}
	return out, nil
}

func (r *reader) PullRequest(ctx context.Context, id string, number int64) (githubpr.PullRequest, error) {
	var p githubpr.PullRequest
	targets := append(summaryTargets(&p.PullRequestSummary), &p.Description)
	err := r.tx.QueryRow(ctx, `SELECT `+summaryFields+`, description FROM project_pull_requests WHERE project_id=$1 AND number=$2`, id, number).Scan(targets...)
	if err != nil {
		return githubpr.PullRequest{}, pg.QueryError("read github pull request", err)
	}
	return p, nil
}

// Search uses position rather than SQL LIKE, so wildcard characters are literal.
const filter = `project_id=$1 AND ($2='all' OR state=CASE WHEN $2='active' THEN 'open' ELSE $2 END)
 AND ($3='' OR strpos(lower(title), lower($3))>0 OR ($4<>'' AND strpos(number::text,$4)>0))`

func numericSearch(q string) string {
	n := strings.TrimPrefix(q, "#")
	if n == "" {
		return ""
	}
	for _, c := range n {
		if c < '0' || c > '9' {
			return ""
		}
	}
	return n
}

func (r *reader) PullRequests(ctx context.Context, q store.GitHubPRQuery) (store.GitHubPRPage, error) {
	page := store.GitHubPRPage{Items: []githubpr.PullRequestSummary{}, UpperNumber: q.UpperNumber}
	numeric := numericSearch(q.Query)
	// Total covers the entire matching collection, independently of page and upper bound.
	if err := r.tx.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE `+filter, q.ProjectID, q.State, q.Query, numeric).Scan(&page.Total); err != nil {
		return store.GitHubPRPage{}, pg.QueryError("count github pull requests", err)
	}
	order, comparison := "DESC", "<"
	if q.Previous {
		order, comparison = "ASC", ">"
	}
	rows, err := r.tx.Query(ctx, `SELECT `+summaryFields+` FROM project_pull_requests WHERE `+filter+
		` AND ($5::bigint IS NULL OR number <= $5) AND ($6::bigint IS NULL OR number `+comparison+` $6)
		 ORDER BY number `+order+` LIMIT $7`, q.ProjectID, q.State, q.Query, numeric, q.UpperNumber, q.AnchorNumber, q.Limit+1)
	if err != nil {
		return store.GitHubPRPage{}, pg.QueryError("list github pull requests", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p githubpr.PullRequestSummary
		if err := rows.Scan(summaryTargets(&p)...); err != nil {
			return store.GitHubPRPage{}, pg.QueryError("list github pull requests", err)
		}
		page.Items = append(page.Items, p)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubPRPage{}, pg.QueryError("list github pull requests", err)
	}
	page.HasMore = len(page.Items) > q.Limit
	if page.HasMore {
		page.Items = page.Items[:q.Limit]
	}
	if q.Previous {
		for i, j := 0, len(page.Items)-1; i < j; i, j = i+1, j-1 {
			page.Items[i], page.Items[j] = page.Items[j], page.Items[i]
		}
	}
	if page.UpperNumber == nil && len(page.Items) > 0 {
		number := page.Items[0].Number
		page.UpperNumber = &number
	}
	return page, nil
}

func (r *reader) PullRequestCounts(ctx context.Context, id string) (store.GitHubPRCounts, error) {
	var counts store.GitHubPRCounts
	err := r.tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE state='open'), count(*) FILTER (WHERE state='closed'),
	 count(*) FILTER (WHERE state='merged'), count(*) FROM project_pull_requests WHERE project_id=$1`, id).
		Scan(&counts.Active, &counts.Closed, &counts.Merged, &counts.All)
	if err != nil {
		return store.GitHubPRCounts{}, pg.QueryError("count github pull request states", err)
	}
	return counts, nil
}
