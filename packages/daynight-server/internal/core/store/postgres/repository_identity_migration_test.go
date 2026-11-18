package postgres

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	repositoryidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/repositoryidentity/v1"
	migration082 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/082"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRepositoryIdentityMigrationFrozenChecksum(t *testing.T) {
	const installedChecksum = "23af4a55489e2f61c97adcc67f7f01c3dd6759cace2f63603bef82bc2453335d"
	if got := schemaMigrations[81].checksum(); got != installedChecksum {
		t.Fatalf("migration 82 no longer matches its installed ledger checksum: got=%s want=%s", got, installedChecksum)
	}
}

func repositoryMigrationFixture(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
	team := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO teams(id,name) VALUES($1,'Repository migration')`, team); err != nil {
		t.Fatal(err)
	}
	return pool, team
}

func putMigrationRepository(t *testing.T, pool *pgxpool.Pool, team, address string, deleted bool) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO projects(id,name,repo_url,deleted_at) VALUES($1,'Migration Project',$2,CASE WHEN $3 THEN statement_timestamp() ELSE NULL END)`, id, address, deleted); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, id, team); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRepositoryIdentityMigrationPreservesHistoricalFacts(t *testing.T) {
	pool, team := repositoryMigrationFixture(t)
	address := "ssh://git@GitHub.com:22/Org/Repo.git/"
	first := putMigrationRepository(t, pool, team, address, false)
	putMigrationRepository(t, pool, team, "https://github.com/Org/Repo", true)
	unknown := putMigrationRepository(t, pool, team, "https://user:private-credential@host/repo", false)
	for i := 0; i < 260; i++ {
		putMigrationRepository(t, pool, team, "https://example.com/"+uuid.NewString(), false)
	}
	var before string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(p) ORDER BY id)::text FROM projects p`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	ctx := migration082.WithLogger(t.Context(), slog.New(slog.NewJSONHandler(&logs, nil)))
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after, identity, raw string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(p)-'repository_identity' ORDER BY id)::text FROM projects p`).Scan(&after); err != nil || after != before {
		t.Fatalf("historical facts changed: equal=%t err=%v", before == after, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT repo_url,repository_identity FROM projects WHERE id=$1`, first).Scan(&raw, &identity); err != nil || raw != address || identity != "github.com/Org/Repo" {
		t.Fatalf("backfill: raw=%q identity=%q err=%v", raw, identity, err)
	}
	var legacy *string
	if err := pool.QueryRow(t.Context(), `SELECT repository_identity FROM projects WHERE id=$1`, unknown).Scan(&legacy); err != nil || legacy != nil {
		t.Fatalf("unknown legacy identity: %v %v", legacy, err)
	}
	if output := logs.String(); !strings.Contains(output, unknown) || !strings.Contains(output, `"migration_version":82`) || !strings.Contains(output, "project_repository_identity_unavailable") || strings.Contains(output, "private-credential") || strings.Contains(output, "host/repo") {
		t.Fatalf("missing or unredacted migration diagnostic: %s", output)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations[:81]); err == nil || !strings.Contains(err.Error(), "82 is not an ordered prefix") {
		t.Fatalf("old binary accepted upgraded database: %v", err)
	}
	if !strings.Contains(schemaMigrations[81].transformSource, repositoryidentity.Source) {
		t.Fatal("migration checksum omits repository identity rules")
	}
}

func TestRepositoryIdentityMigrationRollsBackConflicts(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "equivalent", true: "unknown original"}[unknown], func(t *testing.T) {
			pool, team := repositoryMigrationFixture(t)
			first, second := "https://github.com/Org/Repo.git", "git@github.com:Org/Repo"
			if unknown {
				first, second = "invalid credential:private-secret", "invalid credential:private-secret"
			}
			one := putMigrationRepository(t, pool, team, first, false)
			two := putMigrationRepository(t, pool, team, second, false)
			err := migrate(t.Context(), pool, schemaMigrations)
			diagnostic := migrationErrorMessages(err)
			if err == nil || !strings.Contains(diagnostic, team) || !strings.Contains(diagnostic, one) || !strings.Contains(diagnostic, two) || strings.Contains(diagnostic, "private-secret") || strings.Contains(diagnostic, "github.com") {
				t.Fatalf("migration conflict diagnostic: %v", err)
			}
			var columns, ledger int
			if err := pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' AND column_name='repository_identity'),(SELECT count(*) FROM schema_migrations WHERE version=82)`).Scan(&columns, &ledger); err != nil || columns != 0 || ledger != 0 {
				t.Fatalf("failed migration persisted schema or ledger: %d %d %v", columns, ledger, err)
			}
			if _, err := pool.Exec(t.Context(), `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, two); err != nil {
				t.Fatal(err)
			}
			if err := migrate(context.Background(), pool, schemaMigrations); err != nil {
				t.Fatalf("corrected upgrade cannot recover: %v", err)
			}
		})
	}
}

func migrationErrorMessages(err error) string {
	if err == nil {
		return ""
	}
	result := err.Error()
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			result += "\n" + migrationErrorMessages(child)
		}
	} else if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		result += "\n" + migrationErrorMessages(wrapped.Unwrap())
	}
	return result
}
