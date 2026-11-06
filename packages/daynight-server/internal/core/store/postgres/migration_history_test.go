package postgres

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestHistoricalUpgradePreservesMaterialsAndCreatesOAuthTables(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'legacy-user',now(),now())`, queryID(2))
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Legacy project','https://example.test/repo')`, queryID(1))
	mustQueryExec(t, s, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, queryID(1), queryID(2))
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,required_platform,properties)
		VALUES($1,$3,'Legacy task','## Original Markdown','proposed',9007199254740993,true,'linux',
		'{"pullRequests":[{"url":"https://example.test/pr","title":"Original"}]}'),
		($2,$3,'Dependency','Preserved','done',7,false,NULL,'{"pullRequests":[]}')`, queryID(10), queryID(11), queryID(1))
	mustQueryExec(t, s, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false)`, queryID(1), queryID(10), queryID(11))
	mustQueryExec(t, s, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'nested/plan.md','text/markdown',123)`, queryID(1), queryID(10))

	facts := statusMigrationRelatedFacts(t, s)
	before := statusMigrationRows(t, s)
	if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
		t.Fatal(err)
	}
	afterStatus := statusMigrationRows(t, s)
	if len(afterStatus) != 2 || afterStatus[0].Status != "todo" || afterStatus[0].Version != before[0].Version+1 || afterStatus[0].Materials != before[0].Materials || !reflect.DeepEqual(afterStatus[1], before[1]) {
		t.Fatalf("status migration changed legacy task materials: before=%+v after=%+v", before, afterStatus)
	}
	var statusLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=14`).Scan(&statusLedger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	// Later migrations add project columns, so compare only the old ledger and
	// resource tables that are unchanged by the intervening schema changes.
	currentFacts := statusMigrationRelatedFacts(t, s)
	for _, key := range []string{"ledger", "dependencies", "attachments"} {
		if currentFacts[key] != facts[key] {
			t.Fatalf("upgrade changed %s: before=%s after=%s", key, facts[key], currentFacts[key])
		}
	}
	var currentLedger string
	var versions []int64
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=14`).Scan(&currentLedger); err != nil || currentLedger != statusLedger {
		t.Fatalf("upgrade changed applied ledger: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT array_agg(version ORDER BY version) FROM schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	wantVersions := make([]int64, len(schemaMigrations))
	for i, m := range schemaMigrations {
		wantVersions[i] = m.version
	}
	if !reflect.DeepEqual(versions, wantVersions) {
		t.Fatalf("upgrade ledger: got %v want %v", versions, wantVersions)
	}
	if len(versions) < 39 || versions[37] != 38 || versions[38] != 39 {
		t.Fatalf("OAuth migrations missing from ledger: %v", versions)
	}
	task := snapshotTask(t, s, queryID(1), queryID(10))
	prs, err := taskproperty.PullRequests(task.Properties)
	if err != nil || len(prs) != 1 || prs[0].URL != "https://example.test/pr" || prs[0].Title != "Original" || task.Title != "Legacy task" || task.Description != "## Original Markdown" || task.Status != "todo" || task.Version != 9007199254740994 || !task.UpdatedAt.Equal(afterStatus[0].UpdatedAt) || !task.AllowAgents || task.RequiredPlatform == nil || *task.RequiredPlatform != "linux" || !reflect.DeepEqual(task.DependsOn, []string{queryID(11)}) {
		t.Fatalf("upgrade changed task or migrated properties: task=%+v prs=%+v err=%v", task, prs, err)
	}
	var grants, access, refresh, clients int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens), (SELECT count(*) FROM oauth_clients)`).Scan(&grants, &access, &refresh, &clients); err != nil || grants != 0 || access != 0 || refresh != 0 || clients != 0 {
		t.Fatalf("new OAuth tables: grants=%d access=%d refresh=%d clients=%d err=%v", grants, access, refresh, clients, err)
	}
	var fullLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t`).Scan(&fullLedger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var repeatedLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t`).Scan(&repeatedLedger); err != nil || repeatedLedger != fullLedger {
		t.Fatalf("repeat changed applied ledger: %v", err)
	}
	if repeated := snapshotTask(t, s, queryID(1), queryID(10)); !reflect.DeepEqual(repeated, task) || !reflect.DeepEqual(statusMigrationRelatedFacts(t, s), currentFacts) {
		t.Fatal("repeat changed task or related materials")
	}
}
