package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	migration026 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal/migration026"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
func TestLoginScopeMigrationProtectsLiveTransactions(t *testing.T) {
	for _, resolution := range []string{"consume", "expire"} {
		t.Run(resolution, func(t *testing.T) {
			ctx := context.Background()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:46]); err != nil {
				t.Fatal(err)
			}
			_, err := pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at)
 VALUES ('00000000-0000-4000-8000-000000000001',decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),'github','/',clock_timestamp()+interval '10 minutes'),
 ('00000000-0000-4000-8000-000000000002',decode(repeat('03',32),'hex'),decode(repeat('04',32),'hex'),'github','/',clock_timestamp()-interval '1 minute')`)
			if err != nil {
				t.Fatal(err)
			}
			err = migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != "P1047" {
				t.Fatalf("expected active login migration failure: %v", err)
			}
			_, err = Open(ctx, pool.Config().ConnString())
			if err == nil || !strings.Contains(err.Error(), "active login transactions to be consumed or expired") {
				t.Fatalf("startup did not explain migration failure: %v", err)
			}
			var rows, columns, versions int
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),
 (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='login_transactions' AND column_name='scope_hash'),
 (SELECT count(*) FROM schema_migrations WHERE version=47)`).Scan(&rows, &columns, &versions); err != nil || rows != 2 || columns != 0 || versions != 0 {
				t.Fatalf("failed migration changed data or schema: rows=%d columns=%d ledger=%d err=%v", rows, columns, versions, err)
			}
			if resolution == "consume" {
				_, err = pool.Exec(ctx, `DELETE FROM login_transactions WHERE id='00000000-0000-4000-8000-000000000001' AND state_hash=decode(repeat('01',32),'hex') AND browser_binding_hash=decode(repeat('02',32),'hex')`)
			} else {
				_, err = pool.Exec(ctx, `UPDATE login_transactions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='00000000-0000-4000-8000-000000000001'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions`).Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("expired transactions remain: %d %v", rows, err)
			}
			_, err = pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at) VALUES ('00000000-0000-4000-8000-000000000003',decode(repeat('05',32),'hex'),decode(repeat('06',32),'hex'),'github','/',clock_timestamp()+interval '1 minute')`)
			if err == nil {
				t.Fatal("scope hash accepted as NULL")
			}
		})
	}
}
func storeTokenExpiry(value time.Time) *time.Time { return &value }

func TestOptionalTokenExpiryMigrationPreservesHistoryAndSessionContract(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:18]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, session := identitySession(uuid.NewString(), "historical:"+uuid.NewString())
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,$3,$3)`, user.ID, user.UniAuthID, now)
	mustQueryExec(t, s, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`, session.ID, user.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
	p := model.Principal{Kind: model.SessionCredential, UserID: user.ID, CredentialID: session.ID}
	finite := deviceStoreCredential(now)
	finite.ExpiresAt = storeTokenExpiry(now.Add(30 * 24 * time.Hour))
	finite.UserID = p.UserID
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, finite) }); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'last_used_at')::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(p)-'last_used_at')::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("optional expiry changed historical credential: %v", err)
	}
	var patRequired, sessionRequired bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid='personal_access_tokens'::regclass AND attname='expires_at'),(SELECT attnotnull FROM pg_attribute WHERE attrelid='sessions'::regclass AND attname='expires_at')`).Scan(&patRequired, &sessionRequired); err != nil || patRequired || !sessionRequired {
		t.Fatalf("expiry schema boundaries: PAT=%t session=%t %v", patRequired, sessionRequired, err)
	}
	never := deviceStoreCredential(now)
	never.UserID = p.UserID
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, never) }); err != nil {
		t.Fatal(err)
	}
	future := now.Add(365 * 24 * time.Hour)
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("nonexpiring token expired: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, finite.TokenHash, future); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("historical finite expiry lost: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.SessionCredential, session.TokenHash, session.ExpiresAt); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("session became nonexpiring: %v", err)
	}
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().CleanupCredentials(ctx, future) }); err != nil {
		t.Fatal(err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("cleanup deleted nonexpiring token: %v", err)
	}
}
func TestWorkerPlatformPreferenceMigrationPreservesConfigurationAndObservation(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:53]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	userID, workerID, uninitializedID := queryID(1), queryID(2), queryID(3)
	stamp := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, uninitializedID, stamp))
	value := storeWorkerConfiguration()
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: queryID(4), NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage(`null`)}}}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "preferPlatformSpecificTasks")
	encoded, err = json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	observation := `{"baseRevision":"7","desiredRevision":"9","items":[{"key":{"kind":"projectRemoval","projectId":"00000000-0000-4000-8000-000000000004"},"targetRevision":"8","appliedValue":null,"state":"error","error":{"code":"timeout","category":"runtime","phase":"stop","occurredAt":"2026-11-09T00:00:00Z"},"lastFailure":{"code":"timeout","category":"runtime","phase":"stop","occurredAt":"2026-11-09T00:00:00Z"},"nextAttemptAt":"2026-11-09T00:01:00Z"}],"reportedAt":"2026-11-09T00:00:00Z"}`
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=$4,configuration_observation_revision=8,configuration_observation=$5 WHERE user_id=$1 AND worker_id=$2`, userID, workerID, stamp, encoded, observation)
	rows := func() []string {
		t.Helper()
		var result []string
		if err := pool.QueryRow(ctx, `SELECT array_agg((to_jsonb(w) || jsonb_build_object('desired_configuration',desired_configuration-'preferPlatformSpecificTasks'))::text ORDER BY worker_id) FROM workers w`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := rows()
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, rows()) {
		t.Fatal("preference migration changed existing worker, configuration, or observation facts")
	}
	var present bool
	if err := pool.QueryRow(ctx, `SELECT desired_configuration->'preferPlatformSpecificTasks'='false'::jsonb FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&present); err != nil || !present {
		t.Fatalf("initialized configuration did not acquire disabled preference: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		resource, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		if err != nil {
			return err
		}
		if resource.Desired == nil || resource.Desired.Value.PreferPlatformSpecificTasks || resource.Desired.Revision != "9" || resource.ObservationRevision != "8" || resource.Observation == nil || len(resource.Observation.Items) != 1 || resource.Observation.Items[0].Key.Kind != "projectRemoval" {
			t.Fatalf("migrated resource differs: %+v", resource)
		}
		uninitialized, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, uninitializedID)
		if err == nil && (uninitialized.Desired != nil || uninitialized.Observation != nil || uninitialized.ObservationRevision != "0") {
			t.Fatalf("migration initialized an untouched worker: %+v", uninitialized)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, rows()) {
		t.Fatal("repeat migration changed configuration facts")
	}
}
func TestT03PopulatedT02UpgradeAndSourceCapture(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if len(schemaMigrations) < 51 || schemaMigrations[48].version != 49 || schemaMigrations[49].version != 50 || schemaMigrations[50].version != 51 {
		t.Fatal("unexpected migration boundary")
	}
	if err = migrate(ctx, pool, schemaMigrations[:49]); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(migration026.TransformSource()))
	if fmt.Sprintf("%x", digest) != "2e3c075680247546672293a9d32fb66dee88983b3d0f601f5b4d3fe6144f5f05" {
		t.Fatalf("migration 026 source changed: %x", digest)
	}
	user, session, team, project, oldTask := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, token[:]}},
		{`INSERT INTO teams(id,name) VALUES($1,'existing team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'existing project','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title,description,version) VALUES($1,$2,'existing task','unchanged',9007199254740993)`, []any{oldTask, project}},
	} {
		if _, err = pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	// This is the persisted T02 shape. Current management code also writes the
	// T04 wait table, which does not exist on the 49 schema under test.
	endpoint, key, originalSubscription, originalBinding := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	const originalEpoch int64 = 1
	destination := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`)
	secret := bytes.Repeat([]byte{9}, 32)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://receiver.example',$3,$4,now(),now())`, []any{endpoint, user, destination, key}},
		{`INSERT INTO webhook_signing_keys(id,endpoint_id,slot,secret,created_at) VALUES($1,$2,'current',$3,now())`, []any{key, endpoint, secret}},
		{`INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, []any{originalSubscription, endpoint, project, user}},
		{`INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at) VALUES($1,$2,'task.created',now())`, []any{originalBinding, originalSubscription}},
	} {
		if _, err = pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() string {
		var value string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=49),
 'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$1),
 'endpoints',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_endpoints e),
 'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM webhook_signing_keys k),
 'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM webhook_subscriptions s),
 'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM webhook_bindings b),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY version) FROM webhook_policies p))::text`, oldTask).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	if err = migrate(ctx, pool, schemaMigrations[:50]); err != nil {
		t.Fatal(err)
	}
	upgraded := &Store{Pool: pool}
	if after := snapshot(); after != before {
		t.Fatalf("T02 data or old ledger changed: before=%s after=%s", before, after)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 50 {
		t.Fatalf("migration count=%d err=%v", count, err)
	}
	for _, index := range []string{"webhook_deliveries_due", "webhook_deliveries_fifo", "webhook_deliveries_event", "webhook_deliveries_endpoint_revision", "webhook_deliveries_metadata_expiry", "webhook_deliveries_purging", "webhook_delivery_matches_subscription", "webhook_delivery_matches_binding"} {
		var valid bool
		err = pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1 AND i.indisvalid AND i.indisready)`, index).Scan(&valid)
		if err != nil || !valid {
			t.Fatalf("index %s missing: %v", index, err)
		}
	}
	var defaultExpr string
	if err = pool.QueryRow(ctx, `SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='webhook_deliveries'::regclass AND a.attname='queue_order'`).Scan(&defaultExpr); err != nil || !strings.Contains(defaultExpr, "webhook_delivery_queue_order_seq") {
		t.Fatalf("queue default %q: %v", defaultExpr, err)
	}
	// Current Task DAO reads typed columns and tag references; supply their
	// structural shape while keeping the webhook ledger at version 50 for the
	// 50-to-51 proof.
	if _, err = pool.Exec(ctx, `ALTER TABLE tasks ADD COLUMN type text NOT NULL DEFAULT 'task'; ALTER TABLE tasks ADD COLUMN parent_id uuid`); err != nil {
		t.Fatal(err)
	}
	for _, schema := range []string{taskResourceRowsSQL, taskTagsSQL} {
		if _, err = pool.Exec(ctx, schema); err != nil {
			t.Fatal(err)
		}
	}
	tasks := taskservice.NewTasks(upgraded, &webhook.Capturer{})
	status := model.TaskTodo
	var previous int64
	for n := 0; n < 2; n++ {
		created, err := tasks.Create(ctx, principal, project, taskcore.CreateTask{Title: fmt.Sprintf("after upgrade %d", n), Status: &status})
		if err != nil {
			t.Fatal(err)
		}
		var queue, matchCount, actualMatches int64
		var version int64
		var eventID, deliveryID string
		var body, bodyHash, fact, factHash, matchHash []byte
		err = upgraded.Pool.QueryRow(ctx, `SELECT d.queue_order,d.original_match_count,(SELECT count(*) FROM webhook_delivery_matches m WHERE m.delivery_id=d.id),e.task_version,e.id::text,d.id::text,d.body,d.body_sha256,e.fact_bytes,e.fact_sha256,d.original_match_sha256 FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, created.ID).Scan(&queue, &matchCount, &actualMatches, &version, &eventID, &deliveryID, &body, &bodyHash, &fact, &factHash, &matchHash)
		if err != nil || queue <= previous || matchCount != 1 || actualMatches != 1 || version != created.Version {
			t.Fatalf("capture queue=%d matches=%d/%d version=%d err=%v", queue, matchCount, actualMatches, version, err)
		}
		// Build the wire oracle from the persisted source, without the renderer.
		wantBody := fmt.Sprintf(`{"specversion":"1.0","id":"%s","source":"urn:daynight:project:%s","type":"cc.daynight.task.created.v1","subject":"tasks/%s","time":"%s","datacontenttype":"application/json","data":{"projectId":"%s","taskId":"%s","taskVersion":"%d","status":"todo","paused":false}}`, eventID, project, created.ID, created.CreatedAt.UTC().Format(time.RFC3339Nano), project, created.ID, created.Version)
		bodyDigest := sha256.Sum256([]byte(wantBody))
		if !bytes.Equal(body, []byte(wantBody)) || !bytes.Equal(bodyHash, bodyDigest[:]) || !bytes.Equal(fact, []byte(wantBody)) || !bytes.Equal(factHash, bodyDigest[:]) {
			t.Fatalf("captured wire bytes or digest differ: got %s want %s", body, wantBody)
		}
		var subscription, binding, matchProject, eventType string
		var epoch int64
		if err = upgraded.Pool.QueryRow(ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, deliveryID).Scan(&subscription, &binding, &matchProject, &eventType, &epoch); err != nil {
			t.Fatal(err)
		}
		if subscription != originalSubscription || binding != originalBinding || matchProject != project || eventType != "task.created" || epoch != originalEpoch {
			t.Fatalf("original match differs: %s %s %s %s %d", subscription, binding, matchProject, eventType, epoch)
		}
		tuples, err := json.Marshal([][5]string{{originalSubscription, originalBinding, project, "task.created", fmt.Sprint(originalEpoch)}})
		if err != nil {
			t.Fatal(err)
		}
		proofDigest := sha256.Sum256(tuples)
		if !bytes.Equal(matchHash, proofDigest[:]) {
			t.Fatalf("original match digest differs: %x", matchHash)
		}
		previous = queue
	}
	// Advance a populated 50 schema to 51 and prove the new wait is backfilled
	// without altering the capture rows or any existing ledger entries.
	var before51 string
	if err = pool.QueryRow(ctx, `SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_events e),'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM webhook_deliveries d),'matches',(SELECT jsonb_agg(to_jsonb(m) ORDER BY delivery_id,subscription_id,binding_id) FROM webhook_delivery_matches m))::text`).Scan(&before51); err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:51]); err != nil {
		t.Fatal(err)
	}
	var after51 string
	var waitCount int
	if err = pool.QueryRow(ctx, `SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=50),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_events e),'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM webhook_deliveries d),'matches',(SELECT jsonb_agg(to_jsonb(m) ORDER BY delivery_id,subscription_id,binding_id) FROM webhook_delivery_matches m))::text,(SELECT count(*) FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=1 AND owner_kind='personal' AND owner_id=$2 AND not_before IS NULL)`, endpoint, user).Scan(&after51, &waitCount); err != nil || before51 != after51 || waitCount != 1 {
		t.Fatalf("51 upgrade changed capture or old ledger: wait=%d err=%v", waitCount, err)
	}
}
