package worker_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"math"
	"reflect"
	"strings"
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
	if err != nil || !older.LastReportedAt.Equal(stamp) || !reflect.DeepEqual(older.TaskSnapshot, stale.TaskSnapshot) {
		t.Fatalf("upsert did not persist its supplied timestamp: %+v %v", older, err)
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

func TestWorkerSummariesProjectOnlyVisibleTasksWithoutDecodingSnapshots(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	user, project, visible, hidden := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,'P','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES ($1,$2,'admin')`, project, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES ($1,$3,'Visible','in_progress'),($2,$3,'Hidden','done')`, visible, hidden, project)
	execute(t, tx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, hidden)
	execute(t, tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
		SELECT $1, gen_random_uuid(), statement_timestamp() + n * interval '1 millisecond', statement_timestamp(),
		jsonb_build_object('machine',jsonb_build_object('id',$2::text,'name','Summary'),'platform','linux','cpu', jsonb_build_object('unused','Unprojected probe')),
		jsonb_build_object('state','observed','observedAt','2026-01-01T00:00:00Z','items',jsonb_build_array(
		jsonb_build_object('taskId',$3::text,'projectId',$4::text,'title','Unprojected title'),
		jsonb_build_object('taskId',$5::text,'projectId',$4::text))) FROM generate_series(1,100) n`, user, uuid.NewString(), visible, project, hidden)
	projection := &summaryProjectionTransaction{Tx: tx, t: t}
	reader := worker.NewReader(projection)
	var got []store.WorkerSummary
	err := reader.WorkerSummaries(ctx, user, time.Now(), store.Page{Limit: 100}, func(item store.WorkerSummary) (bool, error) {
		got = append(got, item)
		return true, nil
	})
	if err != nil || len(got) != 100 {
		t.Fatalf("summaries: %d %v", len(got), err)
	}
	for _, item := range got {
		if item.Oversized || item.Machine.Name != "Summary" || item.ActiveTaskCount == nil || *item.ActiveTaskCount != 1 || item.TaskObservedAt == nil {
			t.Fatalf("summary: %+v", item)
		}
	}
	execute(t, tx, `DELETE FROM project_grants WHERE project_id=$1`, project)
	count := 0
	err = reader.WorkerSummaries(ctx, user, time.Now(), store.Page{Limit: 1}, func(item store.WorkerSummary) (bool, error) {
		count++
		if item.ActiveTaskCount == nil || *item.ActiveTaskCount != 0 {
			t.Fatalf("revoked visibility: %+v", item)
		}
		return false, nil
	})
	if err != nil || count != 1 {
		t.Fatalf("early stop: %d %v", count, err)
	}
	if projection.queries != 2 {
		t.Fatalf("summary streams used %d queries instead of one each", projection.queries)
	}
}

type summaryProjectionTransaction struct {
	pgx.Tx
	t       *testing.T
	queries int
}

func (tx *summaryProjectionTransaction) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.t.Helper()
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil {
		return rows, err
	}
	tx.queries++
	// PostgreSQL result types expose full JSON payload reads without requiring
	// large stored bodies or assumptions about the query's spelling.
	for _, field := range rows.FieldDescriptions() {
		if field.DataTypeOID == pgtype.JSONOID || field.DataTypeOID == pgtype.JSONBOID {
			rows.Close()
			tx.t.Fatalf("summary query returned JSON payload column %q", field.Name)
		}
	}
	return rows, nil
}

func (tx *summaryProjectionTransaction) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx.t.Helper()
	tx.t.Fatal("summary stream fetched an individual record")
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestWorkerSummaryRejectsMalformedProjectedFields(t *testing.T) {
	tx := workerTransaction(t)
	user, id := uuid.NewString(), uuid.NewString()
	item := snapshot(user, id, time.Now())
	if _, err := worker.NewWriter(tx).UpsertWorker(t.Context(), item); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{
		`UPDATE workers SET task_snapshot='{"state":"observed","items":{}}' WHERE worker_id=$1`,
		`UPDATE workers SET task_snapshot='{"state":"observed","items":[{"taskId":1}]}' WHERE worker_id=$1`,
		`UPDATE workers SET task_snapshot='{"state":"observed","items":[{"taskId":"not-a-uuid"}]}' WHERE worker_id=$1`,
		`UPDATE workers SET task_snapshot='{"state":"unavailable","items":[]}', telemetry=jsonb_set(telemetry,'{machine,name}','42') WHERE worker_id=$1`,
	} {
		execute(t, tx, mutation, id)
		err := worker.NewReader(tx).WorkerSummaries(t.Context(), user, time.Now(), store.Page{Limit: 1}, func(store.WorkerSummary) (bool, error) { return true, nil })
		if err == nil {
			t.Fatalf("malformed summary accepted: %s", mutation)
		}
	}
}

func TestJSONTimestampValidationMatchesGo(t *testing.T) {
	tx := workerTransaction(t)
	cases := []string{"2026-01-02T03:04:05Z", "2026-01-02T3:04:05Z", "2026-01-02T03:04:05,123Z", "2026-01-02T03:04:05+24:60", "2026-01-02T03:04:05-00:00", "0000-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-01-02 03:04:05Z", "2026-01-02t03:04:05Z", "2026-01-02T03:04:05z", "2026-01-02T03:04:05+25:00", "2026-01-02T03:04:05+00:61", "2026-01-02T03:04:60Z", "2026-01-02T24:00:00Z", "2026-01-02T03:04:05.123456789" + strings.Repeat("1", 1000) + "Z", "2026-01-02T3:04:05," + strings.Repeat("1", 1000) + "+24:60", "2026-01-02T03:04:05." + strings.Repeat("1", 1000) + "x"}
	for _, value := range cases {
		raw, _ := json.Marshal(value)
		var decoded time.Time
		goErr := json.Unmarshal(raw, &decoded)
		var invalid bool
		if err := tx.QueryRow(t.Context(), `SELECT `+pg.JSONTimestampInvalid("v")+` FROM (SELECT $1::jsonb AS v) x`, string(raw)).Scan(&invalid); err != nil {
			t.Fatal(err)
		}
		if invalid != (goErr != nil) {
			t.Fatalf("timestamp %q Go=%v SQL invalid=%v", value, goErr, invalid)
		}
		if goErr == nil {
			var compact string
			if err := tx.QueryRow(t.Context(), `SELECT `+pg.CompactJSONTime("v")+` FROM (SELECT $1::text AS v) x`, value).Scan(&compact); err != nil {
				t.Fatal(err)
			}
			parsed, err := time.Parse(time.RFC3339Nano, compact)
			if err != nil || !parsed.Equal(decoded) {
				t.Fatalf("compact timestamp %q: %v", value, err)
			}
		}
	}
}

func TestWorkerSummaryAliasesAndNestedDecoderErrors(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	user, id, project, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	stamp := time.Now().UTC()
	if _, err := worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, stamp)); err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'P','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'T','todo')`, task, project)
	execute(t, tx, `UPDATE workers SET telemetry=jsonb_build_object('MACHINE',jsonb_build_object('ID',$2::text,'NAME','first'),'machine',jsonb_build_object('Name','second'),'PLATFORM','linux'),
		task_snapshot=jsonb_build_object('STATE','observed','ITEMS',jsonb_build_array(jsonb_build_object('TaſkId',$3::text,'PROJECTID',$4::text)),'OBSERVEDAT','2026-01-02T03:04:05Z') WHERE worker_id=$1`, id, uuid.NewString(), task, project)
	reader := worker.NewReader(tx)
	full, err := reader.Worker(ctx, user, id, stamp)
	if err != nil {
		t.Fatal(err)
	}
	var got store.WorkerSummary
	err = reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(value store.WorkerSummary) (bool, error) { got = value; return true, nil })
	if err != nil || got.Machine != full.Telemetry.Machine || got.Platform != full.Telemetry.Platform || got.TaskObservationState != full.TaskSnapshot.State || got.ActiveTaskCount == nil || *got.ActiveTaskCount != len(full.TaskSnapshot.Items) || got.TaskObservedAt == nil || !got.TaskObservedAt.Equal(*full.TaskSnapshot.ObservedAt) {
		t.Fatalf("alias projection: %+v %v", got, err)
	}
	// A second array alias reuses existing slice elements during Go decoding.
	execute(t, tx, `UPDATE workers SET task_snapshot=jsonb_build_object('state','observed','Items',jsonb_build_array(jsonb_build_object('taskId',$2::text)), 'items',jsonb_build_array(jsonb_build_object('projectId',$3::text))) WHERE worker_id=$1`, id, task, project)
	merged, err := reader.Worker(ctx, user, id, stamp)
	if err != nil || len(merged.TaskSnapshot.Items) != 1 {
		t.Fatalf("full alias merge: %+v %v", merged.TaskSnapshot, err)
	}
	got = store.WorkerSummary{}
	err = reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(value store.WorkerSummary) (bool, error) { got = value; return true, nil })
	if err != nil || got.ActiveTaskCount == nil || *got.ActiveTaskCount != 1 {
		t.Fatalf("summary alias merge: %+v %v", got, err)
	}
	for _, telemetry := range []string{
		`{"CPU":"bad","cpu":{}}`,
		`{"cpu":{"value":{"logicalProcessors":1.5}}}`,
		`{"cpu":{"value":{"usagePercent":1e400}}}`,
		`{"assistantHost":{"providers":[{"args":[false]}]}}`,
		`{"runtimeConfiguration":{"projects":[{"native":{"model":{"source":42}}}]}}`,
		`{"versions":{"herdr":{"checkedAt":"2026-02-30T00:00:00Z"}}}`,
	} {
		execute(t, tx, `UPDATE workers SET telemetry=$2::jsonb WHERE worker_id=$1`, id, telemetry)
		if _, err := reader.Worker(ctx, user, id, stamp); err == nil {
			t.Fatalf("full read accepted %s", telemetry)
		}
		err := reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(store.WorkerSummary) (bool, error) { return true, nil })
		if err == nil {
			t.Fatalf("summary accepted %s", telemetry)
		}
	}
}

func TestWorkerSummaryLookaheadTaskIDValidation(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	user := uuid.NewString()
	stamp := time.Now().UTC()
	first, second := snapshot(user, uuid.NewString(), stamp), snapshot(user, uuid.NewString(), stamp.Add(time.Second))
	for _, item := range []model.WorkerSnapshot{first, second} {
		if _, err := worker.NewWriter(tx).UpsertWorker(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	execute(t, tx, `UPDATE workers SET task_snapshot='{"state":"observed","items":[{"taskId":"bad"}]}' WHERE worker_id=$1`, second.WorkerID)
	reader := worker.NewReader(tx)
	if _, err := reader.Workers(ctx, user, stamp, store.Page{Limit: 1}); err != nil {
		t.Fatalf("old first page: %v", err)
	}
	seen := 0
	err := reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(store.WorkerSummary) (bool, error) { seen++; return seen < 2, nil })
	if err != nil || seen != 2 {
		t.Fatalf("lookahead: %d %v", seen, err)
	}
	after := &store.Position{CreatedAt: first.CreatedAt, ID: first.WorkerID}
	err = reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1, After: after}, func(store.WorkerSummary) (bool, error) { return true, nil })
	if err == nil {
		t.Fatal("invalid returned task ID accepted")
	}
}

func TestWorkerSummaryLongFractionNormalizes(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	user, id := uuid.NewString(), uuid.NewString()
	stamp := time.Now().UTC()
	if _, err := worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, stamp)); err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `UPDATE workers SET task_snapshot=jsonb_build_object('state','observed','items','[]'::jsonb,'observedAt','2026-01-02T3:04:05.'||repeat('1',8388610)||'+24:60','inventoryObservedAt','2026-01-02T03:04:05,'||repeat('2',1000)||'Z') WHERE worker_id=$1`, id)
	var got store.WorkerSummary
	err := worker.NewReader(tx).WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(value store.WorkerSummary) (bool, error) { got = value; return true, nil })
	want, parseErr := time.Parse(time.RFC3339Nano, "2026-01-02T3:04:05.111111111+24:60")
	if err != nil || parseErr != nil || got.Oversized || got.TaskObservedAt == nil || !got.TaskObservedAt.Equal(want) {
		t.Fatalf("long timestamp: %v %v", err, parseErr)
	}
}

func TestWorkerSummaryItemsAliasSliceReuseAndReset(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	user, id, project, first, second := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	stamp := time.Now().UTC()
	if _, err := worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, stamp)); err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'P','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$3,'A','todo'),($2,$3,'B','todo')`, first, second, project)
	for _, mid := range []string{`[{}]`, `[]`, `null`} {
		execute(t, tx, `SAVEPOINT item_alias`)
		raw := fmt.Sprintf(`{"state":"observed","ITEMS":[{"taskId":%q,"projectId":%q},{"taskId":%q,"projectId":%q}],"Items":%s,"items":[{},{}]}`, first, project, second, project, mid)
		execute(t, tx, `UPDATE workers SET task_snapshot=$2::jsonb WHERE worker_id=$1`, id, raw)
		reader := worker.NewReader(tx)
		full, fullErr := reader.Worker(ctx, user, id, stamp)
		if fullErr != nil {
			execute(t, tx, `ROLLBACK TO SAVEPOINT item_alias`)
			execute(t, tx, `UPDATE workers SET task_snapshot=$2::jsonb WHERE worker_id=$1`, id, raw)
		}
		var got store.WorkerSummary
		summaryErr := reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 1}, func(value store.WorkerSummary) (bool, error) { got = value; return true, nil })
		if (fullErr == nil) != (summaryErr == nil) {
			t.Fatalf("middle %s: full=%v summary=%v", mid, fullErr, summaryErr)
		}
		if fullErr == nil && (got.ActiveTaskCount == nil || *got.ActiveTaskCount != len(full.TaskSnapshot.Items)) {
			t.Fatalf("middle %s: full=%d summary=%v", mid, len(full.TaskSnapshot.Items), got.ActiveTaskCount)
		}
		execute(t, tx, `ROLLBACK TO SAVEPOINT item_alias`)
	}
}
