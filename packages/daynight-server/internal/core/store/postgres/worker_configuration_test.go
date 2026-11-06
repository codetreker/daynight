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
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
)

func storeWorkerConfiguration() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
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
	before := currentTaskFactsFixture(t, database)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	after := readWorkerSnapshot(t, database, userID, workerID, stamp)
	if !reflect.DeepEqual(original, after) || !reflect.DeepEqual(before, currentTaskFactsFixture(t, database)) {
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

func TestWorkerConfigurationStoreFailuresRetainCauses(t *testing.T) {
	ctx := context.Background()
	database := isolatedStore(t)
	userID, workerID := queryID(1), queryID(2)
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, time.Now().UTC()))
	if err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		bad := storeWorkerConfiguration()
		bad.Projects = append(bad.Projects, model.WorkerProjectConfiguration{ProjectID: queryID(3), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}})
		if _, err := tx.WorkerDAO().SetWorkerConfiguration(ctx, userID, workerID, 1, bad); err == nil {
			t.Fatal("invalid native JSON encoding hidden")
		}
		observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`invalid`)}}}
		if err := tx.WorkerDAO().SetWorkerConfigurationObservation(ctx, userID, workerID, 1, observation); err == nil {
			t.Fatal("invalid application JSON encoding hidden")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	dao := pgworker.NewWriter(tx).WorkerDAO()
	if _, err := dao.WorkerConfiguration(ctx, userID, workerID); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed lock failure lost: %v", err)
	}
	if _, err := dao.SetWorkerConfiguration(ctx, userID, workerID, 1, storeWorkerConfiguration()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed update failure lost: %v", err)
	}
	if err := dao.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed observation clock failure lost: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if err := snapshot.(*Snapshot).tx.Rollback(ctx); err != nil {
			return err
		}
		_, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		if !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read failure lost: %v", err)
		}
		return sentinelConfigurationRollback
	}); !errors.Is(err, sentinelConfigurationRollback) {
		t.Fatalf("read operation error lost: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN configuration_observation TO missing_observation`); err != nil {
		t.Fatal(err)
	}
	if err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		return tx.WorkerDAO().SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{}})
	}); err == nil {
		t.Fatal("observation database update failure hidden")
	}
}

var sentinelConfigurationRollback = errors.New("intentional configuration transaction rollback")

func TestWorkerConfigurationStoreReadWriteAndProjectAccess(t *testing.T) {
	database, admin, member, project := membershipFixture(t)
	ctx := context.Background()
	workerID := queryID(90)
	putWorkerSnapshot(t, database, workerSnapshotFixture(admin.UserID, workerID, time.Now().UTC()))
	value := storeWorkerConfiguration()
	var desired model.WorkerDesiredConfiguration
	if err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		current, err := tx.WorkerDAO().WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil || current.Desired != nil || current.ObservationRevision != "0" {
			t.Fatalf("initial configuration lock: %+v %v", current, err)
		}
		if err := tx.WorkerDAO().ConfigurationProjectAccess(ctx, admin.UserID, project.ID); err != nil {
			t.Fatalf("owner Project access rejected: %v", err)
		}
		if err := tx.WorkerDAO().ConfigurationProjectAccess(ctx, member.UserID, project.ID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("inaccessible Project exposed: %v", err)
		}
		desired, err = tx.WorkerDAO().SetWorkerConfiguration(ctx, admin.UserID, workerID, 1, value)
		if err != nil {
			return err
		}
		if desired.Revision != "1" || desired.UpdatedAt.IsZero() || !reflect.DeepEqual(desired.Value, value) {
			t.Fatalf("stored target result: %+v", desired)
		}
		observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}
		return tx.WorkerDAO().SetWorkerConfigurationObservation(ctx, admin.UserID, workerID, 1, observation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil {
			return err
		}
		if current.Desired.Revision != "1" || !current.Desired.UpdatedAt.Equal(desired.UpdatedAt) || !reflect.DeepEqual(current.Desired.Value, value) || current.ObservationRevision != "1" || current.Observation == nil || current.Observation.ReportedAt.IsZero() {
			t.Fatalf("configuration did not roundtrip: %+v", current)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
