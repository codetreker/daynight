package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func workerSnapshotFixture(userID, workerID string, stamp time.Time) model.WorkerSnapshot {
	return model.WorkerSnapshot{
		UserID: userID, WorkerID: workerID, CreatedAt: stamp, LastReportedAt: stamp,
		Telemetry:    model.WorkerTelemetry{Machine: model.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: model.PlatformLinux, WorkingDirectory: "/workspace", SampledAt: stamp},
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}},
	}
}

func workerStoredUTF8(size int) string {
	return strings.Repeat("界", size/3) + strings.Repeat("x", size%3)
}

func putWorkerSnapshot(t *testing.T, database *Store, worker model.WorkerSnapshot) model.WorkerSnapshot {
	t.Helper()
	var result model.WorkerSnapshot
	err := writeWorkerForTest(database, context.Background(), func(tx WorkerScope) error {
		var err error
		result, err = tx.WorkerDAO().UpsertWorker(context.Background(), worker)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func readWorkerSnapshot(t *testing.T, database *Store, userID, workerID string, observedAt time.Time) model.WorkerSnapshot {
	t.Helper()
	var result model.WorkerSnapshot
	err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		var err error
		result, err = snapshot.WorkerDAO().Worker(context.Background(), userID, workerID, observedAt)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func setSnapshotTaskClaim(t *testing.T, database *Store, projectID string, taskNumber int, owner, workerID string) model.WorkerTaskReference {
	t.Helper()
	task := queryTask(t, database, projectID, taskNumber, model.TaskInProgress)
	claim := &model.WorkerClaim{ClaimID: queryID(taskNumber + 100), State: model.WorkerActive, UserID: owner, WorkerID: workerID,
		Machine: model.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: model.PlatformLinux, Agent: model.AgentClaude,
		AgentControlMode: model.AgentControlModeWeb, WorktreeID: queryID(taskNumber + 200), Phase: model.WorkerExecuting, ClaimedAt: task.CreatedAt}
	properties := fixtureTaskProperties(t, claim)
	putTaskPropertyFixture(t, database, task.ID, "worker", properties["worker"])
	putTaskPropertyFixture(t, database, task.ID, "pullRequests", []byte(`[{"url":"\u0000","title":"\ud800"}]`))
	return model.WorkerTaskReference{ProjectID: projectID, TaskID: task.ID, ClaimID: claim.ClaimID}
}

func TestWorkerSnapshotUpsertUnknownStaleAndObservedTime(t *testing.T) {
	database := isolatedStore(t)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	worker.Telemetry.Machine.Name = workerStoredUTF8(256)
	worker.Telemetry.WorkingDirectory = workerStoredUTF8(4096)
	worker.Telemetry.OS = model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: stamp, Value: &model.WorkerOS{
		Type: workerStoredUTF8(64), Arch: workerStoredUTF8(64), Release: workerStoredUTF8(256), Version: workerStoredUTF8(1024),
	}}
	worker.Telemetry.CPU = model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: stamp, Value: &model.WorkerCPU{
		Model: workerStoredUTF8(512), LogicalProcessors: 8, UsagePercent: 37.5,
	}}
	worker.Telemetry.Memory = model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: stamp, Value: &model.WorkerMemory{UsedBytes: 1 << 32, TotalBytes: 1 << 33}}
	worker.Telemetry.Disk = model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: stamp, Value: &model.WorkerDisk{AvailableBytes: 1 << 40, TotalBytes: 1 << 41}}
	version := workerStoredUTF8(256)
	worker.Telemetry.Versions = model.WorkerVersions{Daynight: version,
		Herdr:   model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
		Codex:   model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
		Copilot: model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
	}
	runtimeProjects := make([]model.WorkerRuntimeProject, 128)
	for index := range runtimeProjects {
		runtimeProjects[index] = model.WorkerRuntimeProject{ProjectID: queryID(1000 + index)}
	}
	worker.Telemetry.RuntimeConfiguration = &model.WorkerRuntimeConfiguration{SchemaVersion: 1, Projects: runtimeProjects}
	modelName, unavailable := "gpt-5", "not_found"
	worker.Telemetry.AssistantHost = &model.WorkerAssistantHost{
		ProtocolVersion: 1, ObservedAt: stamp, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot,
		Providers: []model.WorkerAssistantProvider{
			{Provider: model.AgentCodex, Available: true, Args: []string{}},
			{Provider: model.AgentClaude, Available: false, Reason: &unavailable, Args: []string{}},
			{Provider: model.AgentCopilot, Available: true, Model: &modelName, Args: []string{"--effort", "high"}},
		},
	}
	first := putWorkerSnapshot(t, database, worker)
	if first.TaskSnapshot.State != model.WorkerTasksUnavailable || first.TaskSnapshot.ObservedAt != nil || first.TaskSnapshot.Items == nil || !reflect.DeepEqual(first.Telemetry, worker.Telemetry) {
		t.Fatalf("initial unknown inventory changed: %#v", first)
	}
	worker.CreatedAt = stamp.Add(time.Hour)
	worker.LastReportedAt = stamp.Add(time.Second)
	unknown := putWorkerSnapshot(t, database, worker)
	if unknown.TaskSnapshot.State != model.WorkerTasksUnavailable || !unknown.CreatedAt.Equal(stamp) {
		t.Fatalf("repeated unknown inventory or immutable creation changed: %#v", unknown)
	}
	worker.LastReportedAt = stamp.Add(2 * time.Second)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp,
		Items: []model.WorkerObservedTask{{ProjectID: queryID(10), TaskID: queryID(11), ClaimID: queryID(12), Title: "Original task", ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerExecuting, Agent: model.AgentClaude}}}
	observed := putWorkerSnapshot(t, database, worker)
	worker.LastReportedAt = stamp.Add(3 * time.Second)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	stale := putWorkerSnapshot(t, database, worker)
	if stale.TaskSnapshot.State != model.WorkerTasksStale || !reflect.DeepEqual(stale.TaskSnapshot.Items, observed.TaskSnapshot.Items) || !stale.TaskSnapshot.ObservedAt.Equal(*observed.TaskSnapshot.ObservedAt) {
		t.Fatalf("null inventory did not retain the last real task observation: %#v", stale)
	}
	worker.LastReportedAt = stamp.Add(time.Second)
	worker.Telemetry.Machine.Name = "Older report"
	older := putWorkerSnapshot(t, database, worker)
	if !older.LastReportedAt.Equal(worker.LastReportedAt) || older.Telemetry.Machine.Name != "Older report" || !reflect.DeepEqual(older.TaskSnapshot, stale.TaskSnapshot) {
		t.Fatalf("upsert did not persist its supplied observation: %#v", older)
	}
	worker.LastReportedAt = stamp.Add(4 * time.Second)
	worker.Telemetry.AssistantHost = nil
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{}}
	empty := putWorkerSnapshot(t, database, worker)
	if empty.TaskSnapshot.State != model.WorkerTasksObserved || len(empty.TaskSnapshot.Items) != 0 || empty.TaskSnapshot.Items == nil || !reflect.DeepEqual(empty.Telemetry, worker.Telemetry) {
		t.Fatalf("real empty inventory was not a complete observation: %#v", empty)
	}
}

func TestWorkerSnapshotNormalizesTaskReferencesWithoutChangingTasks(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	userID, workerID := queryID(1), queryID(2)
	project := queryProject(t, database, 10)
	otherProject := queryProject(t, database, 11)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, userID)
	valid := setSnapshotTaskClaim(t, database, project.ID, 20, userID, workerID)
	otherUser := setSnapshotTaskClaim(t, database, project.ID, 21, queryID(3), workerID)
	otherWorker := setSnapshotTaskClaim(t, database, project.ID, 22, userID, queryID(4))
	wrongClaim := setSnapshotTaskClaim(t, database, project.ID, 23, userID, workerID)
	wrongClaim.ClaimID = queryID(999)
	completed := setSnapshotTaskClaim(t, database, project.ID, 24, userID, workerID)
	mustQueryExec(t, database, `UPDATE tasks SET status='done' WHERE id=$1`, completed.TaskID)
	deleted := setSnapshotTaskClaim(t, database, project.ID, 25, userID, workerID)
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, deleted.TaskID)
	noMembership := setSnapshotTaskClaim(t, database, otherProject.ID, 26, userID, workerID)
	wrongProject := setSnapshotTaskClaim(t, database, project.ID, 27, userID, workerID)
	wrongProject.ProjectID = otherProject.ID
	missingClaim := queryTask(t, database, project.ID, 28, model.TaskInProgress)
	missing := model.WorkerTaskReference{ProjectID: project.ID, TaskID: queryID(900), ClaimID: queryID(901)}
	before := currentTaskFactsFixture(t, database)
	var items []WorkerTaskSource
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		clock, err := tx.ObservedAt(ctx)
		if err != nil || clock.IsZero() || clock.Location() != time.UTC {
			t.Errorf("invalid database observation: %v, %v", clock, err)
			return err
		}
		claims := []model.WorkerTaskReference{
			otherUser, valid, otherWorker, wrongClaim, completed, deleted, noMembership, wrongProject, missing,
			{ProjectID: project.ID, TaskID: missingClaim.ID, ClaimID: queryID(902)},
		}
		for number := len(claims); number < 256; number++ {
			claims = append(claims, model.WorkerTaskReference{ProjectID: project.ID, TaskID: queryID(2000 + number), ClaimID: queryID(3000 + number)})
		}
		items, err = tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{ObservedAt: clock, Claims: claims})
		return err
	})
	if err != nil || len(items) != 6 {
		t.Fatalf("task source batch did not respect access and deletion: %#v, %v", items, err)
	}
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		seen[item.Task.ID] = true
		if item.ProjectName != project.Name || item.Task.ID == valid.TaskID && (fixtureWorker(t, item.Task.Properties).ClaimID != valid.ClaimID || fixtureWorker(t, item.Task.Properties).UserID != userID || fixtureWorker(t, item.Task.Properties).WorkerID != workerID) {
			t.Fatalf("reported source lost its current claim or Project name: %#v", item)
		}
	}
	for _, ref := range []model.WorkerTaskReference{otherUser, valid, otherWorker, wrongClaim, completed, wrongProject} {
		if !seen[ref.TaskID] {
			t.Fatalf("accessible task missing from batch: %s", ref.TaskID)
		}
	}
	if !reflect.DeepEqual(currentTaskFactsFixture(t, database), before) {
		t.Fatal("observation normalization changed execution or opaque PR bytes")
	}
	err = writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		items, err = tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{}})
		return err
	})
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("empty complete inventory: %#v %v", items, err)
	}
}

func TestWorkerSnapshotReadsCurrentVisibilityWithoutReplacingSavedState(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	userID, workerID := queryID(1), queryID(2)
	project, revoked := queryProject(t, database, 10), queryProject(t, database, 11)
	for id, role := range map[string]string{project.ID: "admin", revoked.ID: "member"} {
		mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, id, userID, role)
	}
	active := setSnapshotTaskClaim(t, database, project.ID, 20, userID, workerID)
	removed := setSnapshotTaskClaim(t, database, project.ID, 21, userID, workerID)
	private := setSnapshotTaskClaim(t, database, revoked.ID, 22, userID, workerID)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(userID, workerID, stamp)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &stamp, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{}}
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		var err error
		sources, err := tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{active, removed, private}})
		if err != nil {
			return err
		}
		byID := make(map[string]WorkerTaskSource, len(sources))
		for _, source := range sources {
			byID[source.Task.ID] = source
		}
		for _, ref := range []model.WorkerTaskReference{active, removed, private} {
			source := byID[ref.TaskID]
			worker.TaskSnapshot.Items = append(worker.TaskSnapshot.Items, model.WorkerObservedTask{
				TaskID: ref.TaskID, ProjectID: ref.ProjectID, ClaimID: ref.ClaimID,
				Title: source.Task.Title, ProjectName: source.ProjectName, Status: source.Task.Status,
				Phase: model.WorkerExecuting, Agent: model.AgentClaude,
			})
		}
		_, err = tx.WorkerDAO().UpsertWorker(ctx, worker)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(worker.TaskSnapshot.Items) != 3 {
		t.Fatalf("report omitted tasks accessible through different roles: %#v", worker.TaskSnapshot.Items)
	}
	mustQueryExec(t, database, `UPDATE tasks SET status='done',title='Current title' WHERE id=$1`, active.TaskID)
	mustQueryExec(t, database, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, active.TaskID)
	putTaskPropertyFixture(t, database, active.TaskID, "pullRequests", []byte(`[]`))
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, removed.TaskID)
	mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, revoked.ID, userID)
	read := readWorkerSnapshot(t, database, userID, workerID, stamp.Add(time.Hour))
	if len(read.TaskSnapshot.Items) != 1 || read.TaskSnapshot.Items[0].TaskID != active.TaskID || read.TaskSnapshot.Items[0].Status != model.TaskInProgress || read.TaskSnapshot.Items[0].Title != "Task" || read.TaskSnapshot.Items[0].Phase != model.WorkerExecuting {
		t.Fatalf("current permission filtering changed saved state or leaked rows: %#v", read.TaskSnapshot)
	}
	var page WorkerPage
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		page, err = snapshot.WorkerDAO().Workers(ctx, userID, stamp.Add(time.Hour), Page{Limit: 50})
		return err
	})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], read) {
		t.Fatalf("list/detail visibility differs: %#v %v", page, err)
	}
	before := currentTaskFactsFixture(t, database)
	err = writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		items, err := tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{private}})
		if err == nil && len(items) != 0 {
			t.Errorf("report retained a revoked project's task: %#v", items)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, revoked.ID, userID)
	restored := readWorkerSnapshot(t, database, userID, workerID, stamp.Add(time.Hour))
	if len(restored.TaskSnapshot.Items) != 2 || !reflect.DeepEqual(restored.TaskSnapshot.Items[1], worker.TaskSnapshot.Items[2]) {
		t.Fatalf("regrant did not restore the historical observation: %#v", restored.TaskSnapshot)
	}
	var saved model.WorkerSnapshot
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		saved, err = pg.ScanWorkerSnapshot(snapshot.(*Snapshot).tx.QueryRow(ctx, `SELECT `+pg.WorkerSnapshotProjection+` FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved, worker) || !reflect.DeepEqual(currentTaskFactsFixture(t, database), before) {
		t.Fatal("visibility checks changed the saved snapshot or task facts")
	}
}

func TestWorkerSnapshotRecentWindowAccountIsolationAndStablePagination(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	userID := queryID(1)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	for index := 2; index < 6; index++ {
		worker := workerSnapshotFixture(userID, queryID(index), stamp.Add(time.Duration(index)*time.Second))
		worker.LastReportedAt = stamp
		if index == 4 {
			worker.LastReportedAt = stamp.Add(-72 * time.Hour)
		}
		if index == 5 {
			worker.LastReportedAt = stamp.Add(-72*time.Hour - time.Microsecond)
		}
		putWorkerSnapshot(t, database, worker)
	}
	putWorkerSnapshot(t, database, workerSnapshotFixture(queryID(100), queryID(2), stamp))
	var position *Position
	for index, expectedID := range []string{queryID(2), queryID(3), queryID(4)} {
		var page WorkerPage
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			page, err = snapshot.WorkerDAO().Workers(ctx, userID, stamp, Page{Limit: 1, After: position})
			return err
		})
		if err != nil || len(page.Items) != 1 || page.Items[0].WorkerID != expectedID || page.HasMore != (index < 2) {
			t.Fatalf("stable page %d: %#v %v", index, page, err)
		}
		last := page.Items[0]
		position = &Position{CreatedAt: last.CreatedAt, ID: last.WorkerID}
		last.LastReportedAt = stamp.Add(time.Second)
		putWorkerSnapshot(t, database, last)
	}
	for _, test := range []struct{ user, worker string }{{userID, queryID(5)}, {queryID(101), queryID(2)}, {userID, queryID(900)}} {
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.WorkerDAO().Worker(ctx, test.user, test.worker, stamp)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unknown/inaccessible/expired worker exposed: %v", err)
		}
	}
	readWorkerSnapshot(t, database, userID, queryID(4), stamp)
}

func TestWorkerSnapshotConcurrentAdmissionResamplesAfterLock(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	worker := workerSnapshotFixture(queryID(1), queryID(2), time.Now().UTC())
	ready, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	var firstTime time.Time
	go func() {
		first <- writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
			admission, err := tx.AdmitWorker(ctx, worker.UserID, worker.WorkerID, 120*time.Second)
			if err != nil {
				return err
			}
			firstTime = admission.ObservedAt
			firstWorker := worker
			firstWorker.CreatedAt = firstTime
			firstWorker.LastReportedAt = firstTime
			if _, err := tx.WorkerDAO().UpsertWorker(ctx, firstWorker); err != nil {
				return err
			}
			close(ready)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	second := make(chan error, 1)
	var result model.WorkerSnapshot
	var admission WorkerAdmission
	go func() {
		second <- writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
			var err error
			admission, err = tx.AdmitWorker(ctx, worker.UserID, worker.WorkerID, 120*time.Second)
			if err != nil {
				return err
			}
			worker.LastReportedAt = admission.ObservedAt
			worker.Telemetry.Machine.Name = "Second report"
			result, err = tx.WorkerDAO().UpsertWorker(ctx, worker)
			return err
		})
	}()
	waitForQueryLock(t, database, "SELECT pg_advisory_xact_lock")
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if admission.LastSeenAt == nil || !admission.LastSeenAt.Equal(firstTime) || admission.ActiveCount != 1 || !admission.ObservedAt.After(firstTime) || !result.LastReportedAt.Equal(admission.ObservedAt) || result.Telemetry.Machine.Name != "Second report" {
		t.Fatalf("admission did not observe committed report after waiting: %+v %#v", admission, result)
	}
}

func TestWorkerSnapshotErrorsRollbackAndPreserveCauses(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	want := errors.New("observation unavailable")
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		if _, err := tx.WorkerDAO().UpsertWorker(ctx, worker); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("write did not preserve callback cause: %v", err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM workers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed worker transaction committed: %d %v", count, err)
	}
	worker.Telemetry.CPU.Value = &model.WorkerCPU{UsagePercent: math.NaN()}
	err = writeWorkerForTest(database, ctx, func(tx WorkerScope) error { _, err := tx.WorkerDAO().UpsertWorker(ctx, worker); return err })
	if err == nil || !strings.Contains(err.Error(), "worker") || errors.Unwrap(err) == nil {
		t.Fatalf("invalid telemetry encoding was hidden: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := writeWorkerForTest(database, canceled, func(WorkerScope) error { t.Error("canceled transaction entered"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transaction: %v", err)
	}

}

func TestWorkerSnapshotReadCancellationAndCorruptStorageStayVisible(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	putWorkerSnapshot(t, database, worker)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		_, err := tx.ObservedAt(canceled)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled database clock hid its cause: %v", err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.WorkerDAO().Workers(canceled, worker.UserID, stamp, Page{Limit: 10})
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled worker list hid its cause: %v", err)
	}
	mustQueryExec(t, database, `UPDATE workers SET telemetry='{"cpu":"invalid"}' WHERE user_id=$1 AND worker_id=$2`, worker.UserID, worker.WorkerID)
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.WorkerDAO().Workers(ctx, worker.UserID, stamp, Page{Limit: 10})
		return err
	})
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("corrupt worker metadata was hidden as an empty list: %v", err)
	}
}

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

type workerSnapshotRow func(...any) error

func (row workerSnapshotRow) Scan(values ...any) error { return row(values...) }

func TestWorkerSnapshotScannerPropagatesStoredDecodeErrors(t *testing.T) {
	want := errors.New("scan unavailable")
	if _, err := pg.ScanWorkerSnapshot(workerSnapshotRow(func(...any) error { return want })); !errors.Is(err, want) {
		t.Fatalf("scan failure lost cause: %v", err)
	}
	for _, values := range []struct{ telemetry, tasks string }{{`{"cpu":"invalid"}`, `{}`}, {`{}`, `{"items":"invalid"}`}} {
		_, err := pg.ScanWorkerSnapshot(workerSnapshotRow(func(destinations ...any) error {
			*destinations[4].(*[]byte) = []byte(values.telemetry)
			*destinations[5].(*[]byte) = []byte(values.tasks)
			return nil
		}))
		if err == nil {
			t.Fatal("stored invalid typed snapshot was silently accepted")
		}
	}
	if _, err := pg.ScanWorkerSnapshot(workerSnapshotRow(func(...any) error { return pgx.ErrNoRows })); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("not-found scan changed cause: %v", err)
	}
}

func writeWorkerForTest(database *Store, ctx context.Context, operation func(WorkerScope) error) error {
	_, err := database.WriteWorker(ctx, operation)
	return err
}
