package github

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// coverageBoundary must be read after the connection lock, so the timestamp
// represents the serialized transition rather than time spent waiting for it.
func coverageBoundary(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var at time.Time
	err := tx.QueryRow(ctx, `SELECT date_trunc('second', clock_timestamp())`).Scan(&at)
	if err != nil {
		return time.Time{}, pg.QueryError("read github coverage clock", err)
	}
	return at, nil
}

func setCoverage(ctx context.Context, tx pgx.Tx, project string, repository int64, enabled bool, at time.Time) error {
	if enabled {
		tag, err := tx.Exec(ctx, `UPDATE project_github_coverage SET ended_at=NULL WHERE project_id=$1 AND repository_id=$2 AND ended_at=$3`, project, repository, at)
		if err != nil {
			return pg.QueryError("reopen github coverage", err)
		}
		if tag.RowsAffected() == 0 {
			if _, err = tx.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,$2,$3)`, project, repository, at); err != nil {
				return pg.QueryError("open github coverage", err)
			}
		}
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM project_github_coverage WHERE project_id=$1 AND repository_id=$2 AND ended_at IS NULL AND started_at=$3`, project, repository, at); err != nil {
		return pg.QueryError("remove empty github coverage", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE project_github_coverage SET ended_at=$3 WHERE project_id=$1 AND repository_id=$2 AND ended_at IS NULL`, project, repository, at); err != nil {
		return pg.QueryError("close github coverage", err)
	}
	return nil
}

// closeConnectionCoverage requires the connection row to be locked already.
func closeConnectionCoverage(ctx context.Context, tx pgx.Tx, project string) error {
	var repo *int64
	var sync bool
	err := tx.QueryRow(ctx, `SELECT repository_id,sync_enabled FROM project_github WHERE project_id=$1`, project).Scan(&repo, &sync)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return pg.QueryError("read closing github coverage", err)
	}
	if !sync || repo == nil {
		return nil
	}
	at, err := coverageBoundary(ctx, tx)
	if err != nil {
		return err
	}
	return setCoverage(ctx, tx, project, *repo, false, at)
}

func (w *writer) PublicationFacts(ctx context.Context, lease store.GitHubLease, repositoryID, number int64, terminalAt *time.Time) (store.GitHubPublicationFacts, bool, error) {
	var facts store.GitHubPublicationFacts
	valid, err := w.ValidLease(ctx, lease)
	if err != nil || !valid {
		return facts, valid, err
	}
	var matching bool
	if err = w.tx.QueryRow(ctx, `SELECT COALESCE(repository_id=$2,false) FROM project_github WHERE project_id=$1`, w.projectID, repositoryID).Scan(&matching); err != nil {
		return facts, false, pg.QueryError("check github publication repository", err)
	}
	if !matching {
		return facts, false, nil
	}
	current, err := (&reader{tx: w.tx}).PullRequest(ctx, w.projectID, number)
	if err == nil {
		facts.Current = &current
	} else if !errors.Is(err, model.ErrNotFound) {
		return facts, false, err
	}
	if terminalAt != nil {
		var period store.GitHubCoveragePeriod
		err = w.tx.QueryRow(ctx, `SELECT started_at,ended_at FROM project_github_coverage WHERE project_id=$1 AND repository_id=$2 AND started_at <= $3 ORDER BY started_at DESC LIMIT 1`, w.projectID, repositoryID, *terminalAt).Scan(&period.StartedAt, &period.EndedAt)
		if err == nil {
			facts.Period = &period
		} else if err != pgx.ErrNoRows {
			return facts, false, pg.QueryError("read github coverage", err)
		}
	}
	return facts, true, nil
}
