package migration083

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"strings"

	repositoryidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/repositoryidentity/v1"
	"github.com/jackc/pgx/v5"
)

//go:embed migrate.go
var source string

type loggerKey struct{}

func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, logger)
}

func migrationLogger(ctx context.Context) *slog.Logger {
	logger, ok := ctx.Value(loggerKey{}).(*slog.Logger)
	if !ok {
		return slog.Default()
	}
	return logger
}

// TransformSource covers the complete frozen transformation and identity rules.
func TransformSource() string {
	return strings.ReplaceAll(source, "\r\n", "\n") + "\x00" + strings.ReplaceAll(repositoryidentity.Source, "\r\n", "\n")
}

// Apply keeps unknown historical addresses accessible and refuses ambiguous
// ownership before the schema change and migration ledger can commit.
func Apply(ctx context.Context, tx pgx.Tx) error {
	after := ""
	for {
		rows, err := tx.Query(ctx, `SELECT id::text,repo_url FROM projects WHERE ($1='' OR id>NULLIF($1,'')::uuid) ORDER BY id LIMIT 256`, after)
		if err != nil {
			return fmt.Errorf("migration 83 read Projects: %w", err)
		}
		type record struct{ id, address string }
		batch := make([]record, 0, 256)
		for rows.Next() {
			var value record
			if err := rows.Scan(&value.id, &value.address); err != nil {
				rows.Close()
				return fmt.Errorf("migration 83 scan Project: %w", err)
			}
			batch = append(batch, value)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("migration 83 read Projects: %w", err)
		}
		if len(batch) == 0 {
			break
		}
		for _, value := range batch {
			identity, err := repositoryidentity.RepositoryIdentity(value.address)
			if err != nil {
				migrationLogger(ctx).WarnContext(ctx, "Historical Project repository identity unavailable", "phase", "repository_identity_backfill", "migration_version", 83, "project_id", value.id, "error_kind", "project_repository_identity_unavailable")
			} else if _, err := tx.Exec(ctx, `UPDATE projects SET repository_identity=$2 WHERE id=$1`, value.id, identity); err != nil {
				return fmt.Errorf("migration 83 update Project %s: %w", value.id, err)
			}
			after = value.id
		}
	}
	rows, err := tx.Query(ctx, `SELECT o.team_id::text,array_agg(p.id::text ORDER BY p.id)
 FROM project_ownership o JOIN projects p ON p.id=o.project_id WHERE p.deleted_at IS NULL
 GROUP BY o.team_id,(p.repository_identity IS NULL),COALESCE(p.repository_identity,p.repo_url COLLATE "C")
 HAVING count(*)>1 ORDER BY o.team_id`)
	if err != nil {
		return fmt.Errorf("migration 83 inspect repository conflicts: %w", err)
	}
	defer rows.Close()
	var conflicts []string
	for rows.Next() {
		var teamID string
		var projectIDs []string
		if err := rows.Scan(&teamID, &projectIDs); err != nil {
			return fmt.Errorf("migration 83 scan repository conflicts: %w", err)
		}
		migrationLogger(ctx).ErrorContext(ctx, "Project repository ownership conflict", "migration_version", 83, "phase", "repository_identity_conflicts", "error_kind", "project_repository_conflict", "team_id", teamID, "project_ids", projectIDs)
		conflicts = append(conflicts, fmt.Sprintf("Team %s Projects [%s]", teamID, strings.Join(projectIDs, ", ")))
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("migration 83 inspect repository conflicts: %w", err)
	}
	if len(conflicts) != 0 {
		return fmt.Errorf("migration 83 project_repository_conflict: %s", strings.Join(conflicts, "; "))
	}
	return nil
}
