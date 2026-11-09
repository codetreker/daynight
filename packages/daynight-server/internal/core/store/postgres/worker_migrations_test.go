package postgres

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
