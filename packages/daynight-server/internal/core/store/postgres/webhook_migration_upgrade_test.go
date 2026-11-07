package postgres

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The immediately preceding deployed schema contains real rows before Open
// upgrades it; both Open calls must preserve those rows and the old ledger.
func TestWebhookUpgradePopulated46AndReopen(t *testing.T) {
	ctx := context.Background()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if len(schemaMigrations) < 47 || schemaMigrations[45].version != 46 || schemaMigrations[46].version != 47 {
		pool.Close()
		t.Fatal("unexpected migration history")
	}
	if err := migrate(ctx, pool, schemaMigrations[:46]); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	user, team, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Existing user',now(),now())`, []any{user, "identity-" + user}},
		{`INSERT INTO teams(id,name) VALUES($1,'Existing team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Existing project','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title,description,version) VALUES($1,$2,'Existing task','Preserved text',9007199254740993)`, []any{task, project}},
	} {
		if _, err := pool.Exec(ctx, step.query, step.args...); err != nil {
			pool.Close()
			t.Fatal(err)
		}
	}
	var oldLedger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&oldLedger); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	pool.Close()
	for attempt := 0; attempt < 2; attempt++ {
		db, err := Open(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		var ledger, title, description, name, role string
		var version int64
		var count int
		err = db.Pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=46), (SELECT count(*) FROM schema_migrations),t.title,t.description,t.version,u.name,tm.role FROM tasks t JOIN project_ownership po ON po.project_id=t.project_id JOIN team_members tm ON tm.team_id=po.team_id JOIN users u ON u.id=tm.user_id WHERE t.id=$1 AND u.id=$2`, task, user).Scan(&ledger, &count, &title, &description, &version, &name, &role)
		if err != nil || ledger != oldLedger || count != len(schemaMigrations) || title != "Existing task" || description != "Preserved text" || version != 9007199254740993 || name != "Existing user" || role != "admin" {
			db.Close()
			t.Fatalf("open %d changed data or ledger: count=%d title=%q version=%d err=%v", attempt, count, title, version, err)
		}
		var policies, buckets int
		err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_policies WHERE version=1),(SELECT count(*) FROM webhook_quota_buckets)`).Scan(&policies, &buckets)
		db.Close()
		if err != nil || policies != 1 || buckets != 16 {
			t.Fatalf("open %d missing webhook initial data: %d %d %v", attempt, policies, buckets, err)
		}
	}
}
