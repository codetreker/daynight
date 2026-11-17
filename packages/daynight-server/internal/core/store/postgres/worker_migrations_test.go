package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestWorkerSnapshotMigrationPreservesExistingTaskData(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:24]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 10)
	claim := &model.WorkerClaim{ClaimID: queryID(120), State: model.WorkerActive, UserID: queryID(1), WorkerID: queryID(2),
		Machine: model.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: model.PlatformLinux, Agent: model.AgentClaude,
		AgentControlMode: model.AgentControlModeWeb, WorktreeID: queryID(220), Phase: model.WorkerExecuting, ClaimedAt: time.Now().UTC()}
	properties := fixtureTaskProperties(t, claim)
	properties["pullRequests"] = json.RawMessage(`[{"url":"\u0000","title":"\ud800"}]`)
	raw, err := json.Marshal(properties)
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,properties) VALUES($1,$2,'Task','in_progress',$3)`, queryID(20), project.ID, string(raw))
	before := workerMigrationRows(t, database)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(workerMigrationRows(t, database), before) {
		t.Fatal("worker registry migration changed old task records")
	}
	var workers, foreignKeys int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workers`).Scan(&workers); err != nil || workers != 0 {
		t.Fatalf("old claims synthesized recent workers: %d %v", workers, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid='workers'::regclass AND contype='f'`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatalf("worker registry added a foreign key: %d %v", foreignKeys, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerConfigurationMigrationPreservesWorkersAndTasks(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:33]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	stamp := time.Now().UTC()
	userID, workerID := queryID(1), queryID(2)
	original := putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	// Construct the pre-034 graph directly; current Project and Task DAOs expect
	// lifecycle columns that are intentionally absent in this source schema.
	projectID, taskID, ownerID, teamID := queryID(10), queryID(20), queryID(30), queryID(31)
	mustQueryExec(t, database, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, ownerID, "migration-owner:"+ownerID)
	mustQueryExec(t, database, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, teamID, ownerID)
	mustQueryExec(t, database, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, ownerID)
	mustQueryExec(t, database, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','host:repo')`, projectID)
	mustQueryExec(t, database, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, teamID)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, ownerID)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status) VALUES($1,$2,'Task','Description','in_progress')`, taskID, projectID)
	before := preCancellationTaskFactsFixture(t, database)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	assertHistoricalTasksHaveNoCancellationTime(t, database)
	after := readWorkerSnapshot(t, database, userID, workerID, stamp)
	if !reflect.DeepEqual(original, after) || !reflect.DeepEqual(before, preCancellationTaskFactsFixture(t, database)) {
		t.Fatal("configuration migration changed telemetry or Task facts")
	}
	var resource model.WorkerConfigurationResource
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		resource, err = snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if resource.Desired != nil || resource.Observation != nil || resource.ObservationRevision != "0" {
		t.Fatalf("legacy config synthesized: %+v", resource)
	}
	var foreignKeys int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid='workers'::regclass AND contype='f'`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatalf("configuration introduced foreign keys: %d %v", foreignKeys, err)
	}
	for _, query := range []string{
		`UPDATE workers SET configuration_revision=1`,
		`UPDATE workers SET configuration_revision=1,configuration_updated_at=statement_timestamp()`,
		`UPDATE workers SET configuration_revision=0,configuration_updated_at=statement_timestamp(),desired_configuration='{}'`,
		`UPDATE workers SET configuration_observation_revision=-1`,
		`UPDATE workers SET configuration_observation='[]'`,
	} {
		if _, err := pool.Exec(ctx, query); err == nil {
			t.Fatalf("invalid configuration state accepted: %s", query)
		}
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerSudoCleanupMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) < 79 || schemaMigrations[78].version != 79 {
		t.Fatal("sudo cleanup migration must follow version 78")
	}
	if err := migrate(ctx, pool, schemaMigrations[:78]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	userID := queryID(1)
	for _, workerID := range []string{queryID(2), queryID(3), queryID(4), queryID(5)} {
		putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	}
	for _, fixture := range []struct{ id, desired string }{
		{queryID(2), `{"other":{"value":7}}`},
		{queryID(3), `{"enableSudoCleanup":true,"other":1}`},
		{queryID(4), `{"enableSudoCleanup":false}`},
	} {
		mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=$4,configuration_observation_revision=8,configuration_observation='{"items":[]}' WHERE user_id=$1 AND worker_id=$2`, userID, fixture.id, stamp, fixture.desired)
	}
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, userID, queryID(3))
	rows := func(query string) string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, query).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	unchanged := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id <> '` + queryID(2) + `'`)
	otherFacts := rows(`SELECT (to_jsonb(w)-'desired_configuration'-'configuration_revision'-'configuration_updated_at')::text FROM workers w WHERE worker_id = '` + queryID(2) + `'`)
	if err := migrate(ctx, pool, schemaMigrations[:79]); err != nil {
		t.Fatal(err)
	}
	if got := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id <> '` + queryID(2) + `'`); got != unchanged {
		t.Fatalf("existing field or null configuration changed: before=%s after=%s", unchanged, got)
	}
	if got := rows(`SELECT (to_jsonb(w)-'desired_configuration'-'configuration_revision'-'configuration_updated_at')::text FROM workers w WHERE worker_id = '` + queryID(2) + `'`); got != otherFacts {
		t.Fatalf("unrelated worker facts changed: before=%s after=%s", otherFacts, got)
	}
	var desired string
	var revision int64
	var updated time.Time
	if err := pool.QueryRow(ctx, `SELECT desired_configuration::text,configuration_revision,configuration_updated_at FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, queryID(2)).Scan(&desired, &revision, &updated); err != nil {
		t.Fatal(err)
	}
	var expected bool
	if err := pool.QueryRow(ctx, `SELECT $1::jsonb = '{"other":{"value":7},"enableSudoCleanup":false}'::jsonb`, desired).Scan(&expected); err != nil || !expected || revision != 10 || !updated.After(stamp) {
		t.Fatalf("migrated desired=%s revision=%d updated=%v err=%v", desired, revision, updated, err)
	}
	beforeRepeat := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`)
	if err := migrate(ctx, pool, schemaMigrations[:79]); err != nil {
		t.Fatal(err)
	}
	if got := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`); got != beforeRepeat {
		t.Fatal("repeated migration changed worker facts")
	}
}

func TestWorkerSudoCleanupMigrationRevisionOverflowRollsBack(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:78]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	userID := queryID(1)
	for _, workerID := range []string{queryID(2), queryID(3)} {
		putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	}
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$2,desired_configuration='{"other":1}' WHERE user_id=$1`, userID, stamp)
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, userID, queryID(3))
	rows := func() string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := rows()
	if err := migrate(ctx, pool, schemaMigrations[:79]); err == nil {
		t.Fatal("exhausted revision did not fail migration")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "22003" {
			t.Fatalf("expected numeric overflow, got %v", err)
		}
	}
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=79`).Scan(&ledger); err != nil || ledger != 0 || rows() != before {
		t.Fatalf("overflow changed workers or migration ledger: ledger=%d err=%v", ledger, err)
	}
}
