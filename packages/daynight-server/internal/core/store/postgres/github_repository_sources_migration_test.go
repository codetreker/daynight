package postgres

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGitHubRepositorySourcesMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 93 })
	if index < 1 || schemaMigrations[index-1].version != 92 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project, unconnected, invalid, connectedEmpty := queryID(301), queryID(302), queryID(303), queryID(304)
	_, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,repository_id,repository_full_name,version,revision)
	 VALUES($1,123,'owner/original',4,8),($2,NULL,NULL,1,0),($3,789,'empty/repo',1,0)`, project, unconnected, connectedEmpty)
	if err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
	 VALUES($1,7,70,'url','original','open',false,'main','sha','2020-01-01','2020-01-02','body','2020-01-03',8)`
	if _, err = pool.Exec(ctx, insert, project); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, insert, invalid); err != nil {
		t.Fatal(err)
	}
	for _, identity := range []struct {
		name string
		id   any
		full any
	}{
		{"missing connection", nil, nil},
		{"missing id", nil, "owner/name"},
		{"zero id", 0, "owner/name"},
		{"negative id", -1, "owner/name"},
		{"missing name", 42, nil},
		{"empty name", 42, ""},
		{"malformed name", 42, "owner/name/extra"},
		{"dot segment", 42, "../name"},
	} {
		t.Run(identity.name, func(t *testing.T) {
			if identity.name != "missing connection" {
				if _, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,repository_id,repository_full_name)
				 VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET repository_id=EXCLUDED.repository_id,repository_full_name=EXCLUDED.repository_full_name`, invalid, identity.id, identity.full); err != nil {
					t.Fatal(err)
				}
			}
			err := migrate(ctx, pool, schemaMigrations[:index+1])
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "DN093" || pgErr.Detail != invalid {
				t.Fatalf("expected identified rejection, got %v", err)
			}
			var title string
			var ledger int
			var changed bool
			err = pool.QueryRow(ctx, `SELECT title,(SELECT count(*) FROM schema_migrations WHERE version=93),
				 to_regclass('project_github_repositories') IS NOT NULL OR EXISTS
				 (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_pull_requests' AND column_name='repository_id')
				 FROM project_pull_requests WHERE project_id=$1 AND number=7`, project).Scan(&title, &ledger, &changed)
			if err != nil || title != "original" || ledger != 0 || changed {
				t.Fatalf("rollback: title=%q ledger=%d changed=%v err=%v", title, ledger, changed, err)
			}
		})
	}
	if _, err = pool.Exec(ctx, `UPDATE project_github SET repository_id=456,repository_full_name='other/repo' WHERE project_id=$1`, invalid); err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT p.repository_id=123 AND p.number=7 AND p.github_id=70 AND p.title='original' AND p.description='body'
	 AND p.github_created_at='2020-01-01'::timestamptz AND p.github_updated_at='2020-01-02'::timestamptz AND p.observed_at='2020-01-03'::timestamptz AND p.revision=8
	 AND g.legacy_repository_id=123 AND g.version=4 AND g.revision=8 AND r.full_name='owner/original'
	 FROM project_pull_requests p JOIN project_github g ON g.project_id=p.project_id
	 JOIN project_github_repositories r ON r.project_id=p.project_id AND r.repository_id=p.repository_id
	 WHERE p.project_id=$1`, project).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("backfill preserved=%v err=%v", preserved, err)
	}
	var count int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM project_github_repositories WHERE project_id=$1`, unconnected).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("unconnected source count=%d err=%v", count, err)
	}
	err = pool.QueryRow(ctx, `SELECT count(*) FROM project_github g JOIN project_github_repositories r
	 ON r.project_id=g.project_id AND r.repository_id=g.legacy_repository_id
	 WHERE g.project_id=$1 AND r.repository_id=789 AND r.full_name='empty/repo'`, connectedEmpty).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("connected source without PRs count=%d err=%v", count, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision)
	 VALUES($1,456,7,71,'other','other','open',false,'main','sha',now(),now(),now(),1)`, project)
	if err != nil {
		t.Fatalf("same number from another source: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_pull_requests SELECT * FROM project_pull_requests WHERE project_id=$1 AND repository_id=123`, project); err == nil {
		t.Fatal("duplicate source and number accepted")
	}
	for _, name := range []string{"project_pull_requests_pkey", "project_pull_requests_state_number", "project_pull_requests_author_number"} {
		var definition string
		err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(c.oid) FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
		 WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=$1 AND i.indisvalid AND i.indisready`, name).Scan(&definition)
		if err != nil || !strings.Contains(definition, "(project_id, repository_id,") {
			t.Fatalf("index %s: %q, %v", name, definition, err)
		}
	}
}

func TestGitHubRepositorySourcesOpenReportsProject(t *testing.T) {
	ctx := t.Context()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 93 })
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project := queryID(305)
	_, err = pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Open(ctx, url)
	if err == nil || !strings.Contains(err.Error(), project) {
		t.Fatalf("startup diagnostic: %v", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("old table: %d %v", count, err)
	}
}
