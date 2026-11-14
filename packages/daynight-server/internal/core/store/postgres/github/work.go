package github

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// The caller holds the Project lock. Acquiring the GitHub row before pending
// rows serializes these operations with broadcasts without a reverse lock order.
func (w *writer) lockConnection(ctx context.Context) (bool, error) {
	var id string
	err := w.tx.QueryRow(ctx, `SELECT project_id::text FROM project_github WHERE project_id=$1 FOR UPDATE`, w.projectID).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, pg.QueryError("lock github connection", err)
	}
	return true, nil
}

func (w *writer) Claim(ctx context.Context, c store.GitHubClaim) (bool, error) {
	locked, err := w.lockConnection(ctx)
	if err != nil || !locked {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github SET claim_token=$4, claim_kind=$5, claim_until=$6, revision=revision+1, updated_at=clock_timestamp()
 WHERE project_id=$1 AND enabled AND sync_enabled AND app_id=$2 AND generation=$3
 AND (not_before IS NULL OR not_before <= clock_timestamp())
 AND (claim_until IS NULL OR claim_until <= clock_timestamp()) AND $6::timestamptz > clock_timestamp()`,
		w.projectID, c.AppID, c.Generation, c.Token, c.Kind, c.Until)
	return affected(tag.RowsAffected(), "claim github work", err)
}

const leasePredicate = `project_id=$1 AND enabled AND sync_enabled AND generation=$2 AND claim_token=$3 AND claim_until>clock_timestamp()`

func affected(rows int64, op string, err error) (bool, error) {
	if err != nil {
		return false, pg.QueryError(op, err)
	}
	return rows == 1, nil
}

func (w *writer) Renew(ctx context.Context, l store.GitHubLease, until time.Time) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github SET claim_until=$4, updated_at=clock_timestamp() WHERE `+leasePredicate+` AND $4::timestamptz>clock_timestamp() AND $4::timestamptz>claim_until`, w.projectID, l.Generation, l.Token, until)
	return affected(tag.RowsAffected(), "renew github work", err)
}

func (w *writer) ValidLease(ctx context.Context, l store.GitHubLease) (bool, error) {
	locked, err := w.lockConnection(ctx)
	if err != nil || !locked {
		return false, err
	}
	var valid bool
	err = w.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_github WHERE `+leasePredicate+`)`, w.projectID, l.Generation, l.Token).Scan(&valid)
	if err != nil {
		return false, pg.QueryError("check github lease", err)
	}
	return valid, nil
}

// Publish applies a finite batch in one SQL statement, so a failed lease check
// cannot leave a partial batch and every row receives the same new revision.
func (w *writer) Publish(ctx context.Context, l store.GitHubLease, items []githubpr.PullRequest) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	if len(items) == 0 || len(items) > 25 {
		return false, fmt.Errorf("github publication batch must contain 1..25 observations")
	}
	args := []any{w.projectID, l.Generation, l.Token}
	values := make([]string, 0, len(items))
	for _, p := range items {
		fields := []any{p.Number, p.GitHubID, p.URL, p.Title, p.AuthorID, p.AuthorLogin, p.State, p.Draft, p.BaseRef, p.HeadRepositoryID, p.HeadRepositoryFullName, p.HeadRef, p.HeadSHA, p.GitHubCreatedAt, p.GitHubUpdatedAt, p.GitHubClosedAt, p.GitHubMergedAt, p.Description, p.ObservedAt, p.SeenPollID}
		placeholders := make([]string, len(fields))
		for i, v := range fields {
			args = append(args, v)
			types := []string{"bigint", "bigint", "text", "text", "bigint", "text", "text", "boolean", "text", "bigint", "text", "text", "text", "timestamptz", "timestamptz", "timestamptz", "timestamptz", "text", "timestamptz", "uuid"}
			placeholders[i] = fmt.Sprintf("$%d::%s", len(args), types[i])
		}
		values = append(values, "("+strings.Join(placeholders, ",")+")")
	}
	query := `WITH lease AS (UPDATE project_github SET revision=revision+1, updated_at=clock_timestamp() WHERE ` + leasePredicate + ` RETURNING revision),
 input(number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,github_closed_at,github_merged_at,description,observed_at,seen_poll_id) AS (VALUES ` + strings.Join(values, ",") + `),
 written AS (INSERT INTO project_pull_requests (project_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,github_closed_at,github_merged_at,description,observed_at,seen_poll_id,revision)
 SELECT $1::uuid, i.number::bigint,i.github_id::bigint,i.url::text,i.title::text,i.author_id::bigint,i.author_login::text,i.state::text,i.draft::boolean,i.base_ref::text,i.head_repository_id::bigint,i.head_repository_full_name::text,i.head_ref::text,i.head_sha::text,i.github_created_at::timestamptz,i.github_updated_at::timestamptz,i.github_closed_at::timestamptz,i.github_merged_at::timestamptz,i.description::text,i.observed_at::timestamptz,i.seen_poll_id::uuid,lease.revision FROM input i CROSS JOIN lease WHERE true
 ON CONFLICT (project_id,number) DO UPDATE SET github_id=EXCLUDED.github_id,url=EXCLUDED.url,title=EXCLUDED.title,author_id=EXCLUDED.author_id,author_login=EXCLUDED.author_login,state=EXCLUDED.state,draft=EXCLUDED.draft,base_ref=EXCLUDED.base_ref,head_repository_id=EXCLUDED.head_repository_id,head_repository_full_name=EXCLUDED.head_repository_full_name,head_ref=EXCLUDED.head_ref,head_sha=EXCLUDED.head_sha,github_created_at=EXCLUDED.github_created_at,github_updated_at=EXCLUDED.github_updated_at,github_closed_at=EXCLUDED.github_closed_at,github_merged_at=EXCLUDED.github_merged_at,description=EXCLUDED.description,observed_at=EXCLUDED.observed_at,revision=EXCLUDED.revision,seen_poll_id=COALESCE(EXCLUDED.seen_poll_id,project_pull_requests.seen_poll_id) RETURNING 1) SELECT count(*) FROM written`
	var n int
	if err := w.tx.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		return false, pg.QueryError("publish github observations", err)
	}
	return n == len(items), nil
}

// PublishRepository retains the bound identities and advances revision only
// when an observed presentation fact changes.
func (w *writer) PublishRepository(ctx context.Context, l store.GitHubLease, o store.GitHubRepositoryObservation) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github SET
 revision=revision+CASE WHEN installation_account_login IS DISTINCT FROM $6 OR repository_full_name IS DISTINCT FROM $7 OR repository_private IS DISTINCT FROM $8 THEN 1 ELSE 0 END,
 installation_account_login=$6,repository_full_name=$7,repository_private=$8,updated_at=clock_timestamp()
 WHERE `+leasePredicate+` AND installation_id=$4 AND repository_id=$5`, w.projectID, l.Generation, l.Token, o.InstallationID, o.RepositoryID, o.InstallationAccountLogin, o.RepositoryFullName, o.RepositoryPrivate)
	return affected(tag.RowsAffected(), "publish github repository observation", err)
}

func (w *writer) UnseenActive(ctx context.Context, l store.GitHubLease, pollID string, after int64, limit int) ([]int64, bool, error) {
	if limit < 1 || limit > 100 {
		return nil, false, fmt.Errorf("github unseen limit must be 1..100")
	}
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return nil, valid, err
	}
	rows, err := w.tx.Query(ctx, `SELECT number FROM project_pull_requests WHERE project_id=$1 AND state='open' AND seen_poll_id IS DISTINCT FROM $2::uuid AND number>$3 ORDER BY number LIMIT $4`, w.projectID, pollID, after, limit)
	if err != nil {
		return nil, false, pg.QueryError("read unseen github pull requests", err)
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			return nil, false, pg.QueryError("read unseen github pull requests", err)
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, false, pg.QueryError("read unseen github pull requests", err)
	}
	return out, true, nil
}

func (w *writer) Pending(ctx context.Context, l store.GitHubLease, now time.Time, limit int) ([]store.GitHubPendingPR, bool, error) {
	if limit < 1 || limit > 100 {
		return nil, false, fmt.Errorf("github pending limit must be 1..100")
	}
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return nil, valid, err
	}
	rows, err := w.tx.Query(ctx, `SELECT number,generation,request_id::text,delivery_id,received_at,next_attempt_at FROM project_github_pending_prs WHERE project_id=$1 AND generation=$2 AND next_attempt_at<=$3 ORDER BY next_attempt_at,number LIMIT $4`, w.projectID, l.Generation, now, limit)
	if err != nil {
		return nil, false, pg.QueryError("read pending github pull requests", err)
	}
	defer rows.Close()
	out := []store.GitHubPendingPR{}
	for rows.Next() {
		var p store.GitHubPendingPR
		if err := rows.Scan(&p.Number, &p.Generation, &p.RequestID, &p.DeliveryID, &p.ReceivedAt, &p.NextAttemptAt); err != nil {
			return nil, false, pg.QueryError("read pending github pull requests", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, false, pg.QueryError("read pending github pull requests", err)
	}
	return out, true, nil
}

func (w *writer) HasPending(ctx context.Context, l store.GitHubLease) (bool, bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, valid, err
	}
	var pending bool
	err = w.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_github_pending_prs WHERE project_id=$1 AND generation=$2)`, w.projectID, l.Generation).Scan(&pending)
	if err != nil {
		return false, false, pg.QueryError("check pending github pull requests", err)
	}
	return pending, true, nil
}

// HasDuePending retains the connection lock through claim admission so a
// broadcast cannot insert a hint between the work decision and claim.
func (w *writer) HasDuePending(ctx context.Context, now time.Time) (bool, error) {
	locked, err := w.lockConnection(ctx)
	if err != nil || !locked {
		return false, err
	}
	var pending bool
	err = w.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_github_pending_prs p JOIN project_github g ON g.project_id=p.project_id AND g.generation=p.generation AND g.enabled AND g.sync_enabled WHERE p.project_id=$1 AND p.next_attempt_at<=$2)`, w.projectID, now).Scan(&pending)
	if err != nil {
		return false, pg.QueryError("check due github pull requests", err)
	}
	return pending, nil
}

func (w *writer) AckPending(ctx context.Context, l store.GitHubLease, number int64, request string) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `DELETE FROM project_github_pending_prs p USING project_github g WHERE p.project_id=$1 AND p.number=$4 AND p.request_id=$5 AND p.generation=$2 AND g.`+strings.ReplaceAll(leasePredicate, " AND ", " AND g.")+``, w.projectID, l.Generation, l.Token, number, request)
	return affected(tag.RowsAffected(), "acknowledge github pull request", err)
}
func (w *writer) ReschedulePending(ctx context.Context, l store.GitHubLease, number int64, request string, next time.Time) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github_pending_prs p SET next_attempt_at=$6 FROM project_github g WHERE p.project_id=$1 AND p.number=$4 AND p.request_id=$5 AND p.generation=$2 AND g.`+strings.ReplaceAll(leasePredicate, " AND ", " AND g."), w.projectID, l.Generation, l.Token, number, request, next)
	return affected(tag.RowsAffected(), "reschedule github pull request", err)
}
func (w *writer) AckAccessHint(ctx context.Context, l store.GitHubLease, hint string) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github SET access_hint_id=NULL,access_delivery_id=NULL,updated_at=clock_timestamp() WHERE `+leasePredicate+` AND access_hint_id=$4`, w.projectID, l.Generation, l.Token, hint)
	return affected(tag.RowsAffected(), "acknowledge github access hint", err)
}
func (w *writer) SaveRuntime(ctx context.Context, l store.GitHubLease, r store.GitHubRuntimeWrite) (bool, error) {
	valid, err := w.ValidLease(ctx, l)
	if err != nil || !valid {
		return false, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github SET revision=$4,access_state=$5,access_reason=$6,access_checked_at=$7,next_access_check_at=$8,next_poll_at=$9,not_before=$10,last_poll_attempt_at=$11,last_full_success_at=$12,last_full_generation=$13,poll_error_code=$14,poll_error_message=$15,poll_error_at=$16,last_webhook_attempt_at=$17,last_webhook_success_at=$18,webhook_error_code=$19,webhook_error_message=$20,webhook_error_at=$21,claim_token=CASE WHEN $22 THEN NULL ELSE claim_token END,claim_kind=CASE WHEN $22 THEN NULL ELSE claim_kind END,claim_until=CASE WHEN $22 THEN NULL ELSE claim_until END,updated_at=clock_timestamp() WHERE `+leasePredicate+` AND revision=$23`, w.projectID, l.Generation, l.Token, r.Revision, r.AccessState, r.AccessReason, r.AccessCheckedAt, r.NextAccessCheckAt, r.NextPollAt, r.NotBefore, r.LastPollAttemptAt, r.LastFullSuccessAt, r.LastFullGeneration, r.PollErrorCode, r.PollErrorMessage, r.PollErrorAt, r.LastWebhookAttemptAt, r.LastWebhookSuccessAt, r.WebhookErrorCode, r.WebhookErrorMessage, r.WebhookErrorAt, r.ReleaseClaim, r.ExpectedRevision)
	return affected(tag.RowsAffected(), "save github runtime", err)
}

// InvalidateProject is invoked under the Project deletion lock. Historical PRs
// are retained; a later signal cannot revive an already disabled connection.
func InvalidateProject(ctx context.Context, tx pgx.Tx, projectID string) error {
	if _, err := tx.Exec(ctx, `UPDATE project_github SET enabled=false,sync_enabled=false,claim_token=NULL,claim_until=NULL,claim_kind=NULL,next_poll_at=NULL,next_access_check_at=NULL,access_hint_id=NULL,access_delivery_id=NULL,updated_at=clock_timestamp() WHERE project_id=$1`, projectID); err != nil {
		return pg.QueryError("invalidate deleted project github work", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id=$1`, projectID); err != nil {
		return pg.QueryError("clear deleted project github hints", err)
	}
	return nil
}
