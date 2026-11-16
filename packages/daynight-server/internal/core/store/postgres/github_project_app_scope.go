package postgres

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubProjectApp(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return work(github.NewProjectAppReader(tx, id)) }, true)
}

func (s *Store) WriteGitHubProjectApp(ctx context.Context, id, actor, newApp string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin project App write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var locked, team string
		if e := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&locked); e != nil {
			return pg.QueryError("lock App project", e)
		}
		if e := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE`, id).Scan(&team); e != nil {
			return pg.QueryError("lock App ownership", e)
		}
		if e := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, team).Scan(&locked); e != nil {
			return pg.QueryError("lock App owner Team", e)
		}
		if _, e := pg.LockProjectAuthorization(ctx, tx, actor, id); e != nil {
			return e
		}
		var old *string
		e := tx.QueryRow(ctx, `SELECT app_resource_id::text FROM project_github WHERE project_id=$1`, id).Scan(&old)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return pg.QueryError("read candidate App binding", e)
		}
		apps := []string{}
		if old != nil {
			apps = append(apps, *old)
		}
		if newApp != "" && (old == nil || *old != newApp) {
			apps = append(apps, newApp)
		}
		sort.Strings(apps)
		for _, app := range apps {
			e := tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 FOR UPDATE`, app).Scan(&locked)
			if errors.Is(e, pgx.ErrNoRows) {
				var retained bool
				if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_github WHERE project_id=$1 AND app_resource_id=$2)`, id, app).Scan(&retained); e != nil {
					return pg.QueryError("reread missing App binding", e)
				}
				if retained {
					return fmt.Errorf("project connection references a missing App")
				}
				continue
			}
			if e != nil {
				return pg.QueryError("lock project App", e)
			}
		}
		rows, e := tx.Query(ctx, `SELECT id::text FROM github_app_team_grants WHERE app_resource_id=ANY($1::uuid[]) AND team_id=$2 AND revoked_at IS NULL ORDER BY id FOR SHARE`, apps, team)
		if e != nil {
			return pg.QueryError("lock project App grants", e)
		}
		for rows.Next() {
			var grant string
			if e = rows.Scan(&grant); e != nil {
				rows.Close()
				return pg.QueryError("read locked project App grant", e)
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return pg.QueryError("lock project App grants", e)
		}
		return work(github.NewProjectAppWriter(tx, id))
	})
	return teamCompletion("write project App", err)
}
