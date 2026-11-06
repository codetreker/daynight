package worker_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
	"reflect"
	"testing"
	"time"
)

func workerTransaction(t *testing.T) pgx.Tx {
	t.Helper()
	database, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	tx, err := database.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}
func execute(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func snapshot(user, id string, stamp time.Time) model.WorkerSnapshot {
	return model.WorkerSnapshot{UserID: user, WorkerID: id, CreatedAt: stamp, LastReportedAt: stamp, Telemetry: model.WorkerTelemetry{Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Machine"}, Platform: model.PlatformLinux, WorkingDirectory: "/workspace", SampledAt: stamp}, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
}
func configuration() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 2, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
}
func TestWorkerDAOSnapshotRetentionVisibilityAndPagination(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	writer := worker.NewWriter(tx)
	reader := worker.NewReader(tx)
	user := uuid.NewString()
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if writer.WorkerDAO() != writer {
		t.Fatal("writer scope returned a different DAO")
	}
	clock, err := writer.ObservedAt(ctx)
	if err != nil || clock.IsZero() || clock.Location() != time.UTC {
		t.Fatalf("database clock: %v %v", clock, err)
	}
	original := snapshot(user, uuid.NewString(), stamp)
	first, err := writer.UpsertWorker(ctx, original)
	if err != nil || !first.CreatedAt.Equal(stamp) || first.TaskSnapshot.State != model.WorkerTasksUnavailable {
		t.Fatalf("first snapshot: %+v %v", first, err)
	}
	projectID, taskID, hiddenID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','host:repo')`, projectID)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Task','in_progress'),($3,$2,'Hidden','done')`, taskID, projectID, hiddenID)
	original.LastReportedAt = stamp.Add(time.Second)
	original.CreatedAt = stamp.Add(time.Hour)
	original.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &stamp, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{{ProjectID: projectID, TaskID: taskID, ClaimID: uuid.NewString(), Title: "Saved title", Status: model.TaskInProgress}, {ProjectID: projectID, TaskID: hiddenID, ClaimID: uuid.NewString(), Title: "Hidden", Status: model.TaskDone}}}
	observed, err := writer.UpsertWorker(ctx, original)
	if err != nil || !observed.CreatedAt.Equal(stamp) {
		t.Fatalf("immutable creation: %+v %v", observed, err)
	}
	original.LastReportedAt = stamp.Add(2 * time.Second)
	original.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	stale, err := writer.UpsertWorker(ctx, original)
	if err != nil || stale.TaskSnapshot.State != model.WorkerTasksStale || !reflect.DeepEqual(stale.TaskSnapshot.Items, observed.TaskSnapshot.Items) {
		t.Fatalf("stale retention: %+v %v", stale, err)
	}
	original.LastReportedAt = stamp
	older, err := writer.UpsertWorker(ctx, original)
	if err != nil || !reflect.DeepEqual(older, stale) {
		t.Fatalf("older snapshot overwrote saved state: %+v %v", older, err)
	}
	execute(t, tx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, hiddenID)
	got, err := reader.Worker(ctx, user, original.WorkerID, stamp)
	if err != nil || len(got.TaskSnapshot.Items) != 1 || got.TaskSnapshot.Items[0].Title != "Saved title" {
		t.Fatalf("task visibility: %+v %v", got, err)
	}
	another := snapshot(user, uuid.NewString(), stamp.Add(time.Hour))
	if _, err := writer.UpsertWorker(ctx, another); err != nil {
		t.Fatal(err)
	}
	expired := snapshot(user, uuid.NewString(), stamp.Add(-73*time.Hour))
	if _, err := writer.UpsertWorker(ctx, expired); err != nil {
		t.Fatal(err)
	}
	foreign := snapshot(uuid.NewString(), uuid.NewString(), stamp)
	if _, err := writer.UpsertWorker(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	page, err := reader.Workers(ctx, user, stamp, store.Page{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].WorkerID != original.WorkerID || !page.HasMore || len(page.Items[0].TaskSnapshot.Items) != 1 {
		t.Fatalf("first page: %+v %v", page, err)
	}
	page, err = reader.Workers(ctx, user, stamp, store.Page{Limit: 1, After: &store.Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].WorkerID}})
	if err != nil || len(page.Items) != 1 || page.Items[0].WorkerID != another.WorkerID || page.HasMore {
		t.Fatalf("last page: %+v %v", page, err)
	}
	for _, id := range []string{expired.WorkerID, foreign.WorkerID, uuid.NewString()} {
		if _, err := reader.Worker(ctx, user, id, stamp); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unavailable worker %s: %v", id, err)
		}
	}
	execute(t, tx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, projectID)
	got, err = reader.Worker(ctx, user, original.WorkerID, stamp)
	if err != nil || len(got.TaskSnapshot.Items) != 0 || got.TaskSnapshot.State != model.WorkerTasksStale {
		t.Fatalf("deleted project visibility: %+v %v", got, err)
	}
	execute(t, tx, `UPDATE projects SET deleted_at=NULL WHERE id=$1`, projectID)
	execute(t, tx, `DELETE FROM project_grants WHERE project_id=$1`, projectID)
	got, err = reader.Worker(ctx, user, original.WorkerID, stamp)
	if err != nil || len(got.TaskSnapshot.Items) != 0 {
		t.Fatalf("revoked visibility: %+v %v", got, err)
	}
}
func TestWorkerDAOConfigurationRoundtripAndAccess(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	writer := worker.NewWriter(tx)
	reader := worker.NewReader(tx)
	user, id := uuid.NewString(), uuid.NewString()
	stamp := time.Now().UTC()
	if _, err := writer.UpsertWorker(ctx, snapshot(user, id, stamp)); err != nil {
		t.Fatal(err)
	}
	initial, err := writer.WorkerConfiguration(ctx, user, id)
	if err != nil || initial.Desired != nil || initial.Observation != nil || initial.ObservationRevision != "0" {
		t.Fatalf("initial: %+v %v", initial, err)
	}
	desired, err := writer.SetWorkerConfiguration(ctx, user, id, 17, configuration())
	if err != nil || desired.Revision != "17" || desired.UpdatedAt.IsZero() || desired.UpdatedAt.Location() != time.UTC {
		t.Fatalf("desired: %+v %v", desired, err)
	}
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "17", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "native"}, TargetRevision: "17", AppliedValue: json.RawMessage(`{"agent":"codex"}`), State: "applied"}}}
	if err := writer.SetWorkerConfigurationObservation(ctx, user, id, 5, observation); err != nil {
		t.Fatal(err)
	}
	got, err := reader.WorkerConfiguration(ctx, user, id)
	if err != nil || got.Desired == nil || !reflect.DeepEqual(*got.Desired, desired) || got.ObservationRevision != "5" || got.Observation == nil || got.Observation.ReportedAt.IsZero() {
		t.Fatalf("configuration roundtrip: %+v %v", got, err)
	}
	var applied bytes.Buffer
	if err := json.Compact(&applied, got.Observation.Items[0].AppliedValue); err != nil {
		t.Fatal(err)
	}
	got.Observation.Items[0].AppliedValue = json.RawMessage(applied.Bytes())
	if !reflect.DeepEqual(got.Observation.WorkerConfigurationObservation, observation) {
		t.Fatalf("observation roundtrip: %#v, want %#v", got.Observation.WorkerConfigurationObservation, observation)
	}
	if _, err := reader.WorkerConfiguration(ctx, uuid.NewString(), id); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign worker configuration: %v", err)
	}
	project := uuid.NewString()
	ownerTeam := uuid.NewString()
	execute(t, tx, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Owner',statement_timestamp(),statement_timestamp())`, user, user)
	execute(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Configuration Team')`, ownerTeam)
	execute(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, ownerTeam)
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Configuration','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, user)
	if err := writer.ConfigurationProjectAccess(ctx, user, project); err != nil {
		t.Fatal(err)
	}
	if err := writer.ConfigurationProjectAccess(ctx, uuid.NewString(), project); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign project access: %v", err)
	}
	bad := configuration()
	bad.Projects = []model.WorkerProjectConfiguration{{ProjectID: project, NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}}}
	if _, err := writer.SetWorkerConfiguration(ctx, user, id, 18, bad); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("configuration JSON error lost: %v", err)
	}
	observation.Items[0].AppliedValue = json.RawMessage(`invalid`)
	if err := writer.SetWorkerConfigurationObservation(ctx, user, id, 6, observation); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("observation JSON error lost: %v", err)
	}
	invalid := snapshot(user, uuid.NewString(), stamp)
	invalid.Telemetry.CPU.Value = &model.WorkerCPU{UsagePercent: math.NaN()}
	if _, err := writer.UpsertWorker(ctx, invalid); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("telemetry JSON error lost: %v", err)
	}
	invalid = snapshot(user, uuid.NewString(), stamp)
	outsideJSONTime := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	invalid.TaskSnapshot.ObservedAt = &outsideJSONTime
	if _, err := writer.UpsertWorker(ctx, invalid); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("task snapshot JSON error lost: %v", err)
	}

}
func TestWorkerDAOReportedTaskSourcesAndStoredCorruption(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	writer := worker.NewWriter(tx)
	user, project := uuid.NewString(), uuid.NewString()
	task, unclaimed := uuid.NewString(), uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Sources','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Claimed','in_progress'),($3,$2,'Unclaimed','todo')`, task, project, unclaimed)
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), State: model.WorkerActive, UserID: user, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, ClaimedAt: time.Now().UTC()}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task, string(raw))
	items, err := writer.ReportTaskSnapshots(ctx, user, model.WorkerTaskInventory{})
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("empty inventory: %+v %v", items, err)
	}
	inventory := model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{{TaskID: task}, {TaskID: unclaimed}, {TaskID: uuid.NewString()}}}
	items, err = writer.ReportTaskSnapshots(ctx, user, inventory)
	if err != nil || len(items) != 1 || items[0].Task.ID != task || items[0].ProjectName != "Sources" || items[0].Task.Properties["worker"] == nil {
		t.Fatalf("reported sources: %+v %v", items, err)
	}
	execute(t, tx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, project)
	items, err = writer.ReportTaskSnapshots(ctx, user, inventory)
	if err != nil || len(items) != 0 {
		t.Fatalf("deleted project sources: %+v %v", items, err)
	}
	execute(t, tx, `UPDATE projects SET deleted_at=NULL WHERE id=$1`, project)
	items, err = writer.ReportTaskSnapshots(ctx, uuid.NewString(), inventory)
	if err != nil || len(items) != 0 {
		t.Fatalf("private sources: %+v %v", items, err)
	}
	execute(t, tx, `UPDATE task_properties SET value='invalid JSON' WHERE task_id=$1 AND name='worker'`, task)
	if _, err := writer.ReportTaskSnapshots(ctx, user, inventory); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("corrupt worker property accepted: %v", err)
	}
	workerID := uuid.NewString()
	stamp := time.Now().UTC()
	if _, err := writer.UpsertWorker(ctx, snapshot(user, workerID, stamp)); err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `UPDATE workers SET telemetry='{"cpu":"invalid"}' WHERE worker_id=$1`, workerID)
	reader := worker.NewReader(tx)
	if _, err := reader.Worker(ctx, user, workerID, stamp); err == nil {
		t.Fatal("corrupt worker read accepted")
	}
	if _, err := reader.Workers(ctx, user, stamp, store.Page{Limit: 10}); err == nil {
		t.Fatal("corrupt worker list accepted")
	}
}
func TestWorkerDAOClosedTransactionErrors(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	reader := worker.NewReader(tx)
	writer := worker.NewWriter(tx)
	id := uuid.NewString()
	now := time.Now().UTC()
	checks := map[string]func() error{
		"clock":  func() error { _, err := writer.ObservedAt(ctx); return err },
		"upsert": func() error { _, err := writer.UpsertWorker(ctx, snapshot(id, id, now)); return err },
		"sources": func() error {
			_, err := writer.ReportTaskSnapshots(ctx, id, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{{TaskID: id}}})
			return err
		},
		"list":                 func() error { _, err := reader.Workers(ctx, id, now, store.Page{Limit: 1}); return err },
		"read":                 func() error { _, err := reader.Worker(ctx, id, id, now); return err },
		"configuration read":   func() error { _, err := reader.WorkerConfiguration(ctx, id, id); return err },
		"configuration lock":   func() error { _, err := writer.WorkerConfiguration(ctx, id, id); return err },
		"configuration update": func() error { _, err := writer.SetWorkerConfiguration(ctx, id, id, 1, configuration()); return err },
		"observation": func() error {
			return writer.SetWorkerConfigurationObservation(ctx, id, id, 1, model.WorkerConfigurationObservation{})
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, pgx.ErrTxClosed) {
				t.Fatalf("closed transaction cause lost: %v", err)
			}
		})
	}
}
