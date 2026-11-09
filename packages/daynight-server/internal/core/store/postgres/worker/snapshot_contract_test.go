package worker_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestWorkerSnapshotUpsertUnknownStaleAndObservedTime(t *testing.T) {
	database := workerStorage(t)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := testutil.WorkerSnapshotFixture(testutil.QueryID(1), testutil.QueryID(2), stamp)
	worker.Telemetry.Machine.Name = testutil.WorkerStoredUTF8(256)
	worker.Telemetry.WorkingDirectory = testutil.WorkerStoredUTF8(4096)
	worker.Telemetry.OS = model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: stamp, Value: &model.WorkerOS{
		Type: testutil.WorkerStoredUTF8(64), Arch: testutil.WorkerStoredUTF8(64), Release: testutil.WorkerStoredUTF8(256), Version: testutil.WorkerStoredUTF8(1024),
	}}
	worker.Telemetry.CPU = model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: stamp, Value: &model.WorkerCPU{
		Model: testutil.WorkerStoredUTF8(512), LogicalProcessors: 8, UsagePercent: 37.5,
	}}
	worker.Telemetry.Memory = model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: stamp, Value: &model.WorkerMemory{UsedBytes: 1 << 32, TotalBytes: 1 << 33}}
	worker.Telemetry.Disk = model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: stamp, Value: &model.WorkerDisk{AvailableBytes: 1 << 40, TotalBytes: 1 << 41}}
	version := testutil.WorkerStoredUTF8(256)
	worker.Telemetry.Versions = model.WorkerVersions{Daynight: version,
		Herdr:   model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
		Codex:   model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
		Copilot: model.WorkerProbe[string]{State: "ok", CheckedAt: stamp, Value: &version},
	}
	runtimeProjects := make([]model.WorkerRuntimeProject, 128)
	for index := range runtimeProjects {
		runtimeProjects[index] = model.WorkerRuntimeProject{ProjectID: testutil.QueryID(1000 + index)}
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
	first := testutil.PutWorkerSnapshot(t, database, worker)
	if first.TaskSnapshot.State != model.WorkerTasksUnavailable || first.TaskSnapshot.ObservedAt != nil || first.TaskSnapshot.Items == nil || !reflect.DeepEqual(first.Telemetry, worker.Telemetry) {
		t.Fatalf("initial unknown inventory changed: %#v", first)
	}
	worker.CreatedAt = stamp.Add(time.Hour)
	worker.LastReportedAt = stamp.Add(time.Second)
	unknown := testutil.PutWorkerSnapshot(t, database, worker)
	if unknown.TaskSnapshot.State != model.WorkerTasksUnavailable || !unknown.CreatedAt.Equal(stamp) {
		t.Fatalf("repeated unknown inventory or immutable creation changed: %#v", unknown)
	}
	worker.LastReportedAt = stamp.Add(2 * time.Second)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp,
		Items: []model.WorkerObservedTask{{ProjectID: testutil.QueryID(10), TaskID: testutil.QueryID(11), ClaimID: testutil.QueryID(12), Title: "Original task", ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerExecuting, Agent: model.AgentClaude}}}
	observed := testutil.PutWorkerSnapshot(t, database, worker)
	worker.LastReportedAt = stamp.Add(3 * time.Second)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	stale := testutil.PutWorkerSnapshot(t, database, worker)
	if stale.TaskSnapshot.State != model.WorkerTasksStale || !reflect.DeepEqual(stale.TaskSnapshot.Items, observed.TaskSnapshot.Items) || !stale.TaskSnapshot.ObservedAt.Equal(*observed.TaskSnapshot.ObservedAt) {
		t.Fatalf("null inventory did not retain the last real task observation: %#v", stale)
	}
	worker.LastReportedAt = stamp.Add(time.Second)
	worker.Telemetry.Machine.Name = "Older report"
	older := testutil.PutWorkerSnapshot(t, database, worker)
	if !older.LastReportedAt.Equal(worker.LastReportedAt) || older.Telemetry.Machine.Name != "Older report" || !reflect.DeepEqual(older.TaskSnapshot, stale.TaskSnapshot) {
		t.Fatalf("upsert did not persist its supplied observation: %#v", older)
	}
	worker.LastReportedAt = stamp.Add(4 * time.Second)
	worker.Telemetry.AssistantHost = nil
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{}}
	empty := testutil.PutWorkerSnapshot(t, database, worker)
	if empty.TaskSnapshot.State != model.WorkerTasksObserved || len(empty.TaskSnapshot.Items) != 0 || empty.TaskSnapshot.Items == nil || !reflect.DeepEqual(empty.Telemetry, worker.Telemetry) {
		t.Fatalf("real empty inventory was not a complete observation: %#v", empty)
	}
}

func TestWorkerSnapshotNormalizesTaskReferencesWithoutChangingTasks(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	userID, workerID := testutil.QueryID(1), testutil.QueryID(2)
	project := testutil.QueryProject(t, database.Pool, database, 10)
	otherProject := testutil.QueryProject(t, database.Pool, database, 11)
	testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, userID)
	valid := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 20, userID, workerID)
	otherUser := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 21, testutil.QueryID(3), workerID)
	otherWorker := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 22, userID, testutil.QueryID(4))
	wrongClaim := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 23, userID, workerID)
	wrongClaim.ClaimID = testutil.QueryID(999)
	completed := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 24, userID, workerID)
	testutil.MustExec(t, database.Pool, `UPDATE tasks SET status='done' WHERE id=$1`, completed.TaskID)
	deleted := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 25, userID, workerID)
	testutil.MustExec(t, database.Pool, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, deleted.TaskID)
	noMembership := testutil.SetSnapshotTaskClaim(t, database.Pool, database, otherProject.ID, 26, userID, workerID)
	wrongProject := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 27, userID, workerID)
	wrongProject.ProjectID = otherProject.ID
	missingClaim := testutil.QueryTask(t, database, project.ID, 28, model.TaskInProgress)
	missing := model.WorkerTaskReference{ProjectID: project.ID, TaskID: testutil.QueryID(900), ClaimID: testutil.QueryID(901)}
	before := testutil.CurrentTaskFacts(t, database.Pool)
	var items []WorkerTaskSource
	err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
		clock, err := tx.ObservedAt(ctx)
		if err != nil || clock.IsZero() || clock.Location() != time.UTC {
			t.Errorf("invalid database observation: %v, %v", clock, err)
			return err
		}
		claims := []model.WorkerTaskReference{
			otherUser, valid, otherWorker, wrongClaim, completed, deleted, noMembership, wrongProject, missing,
			{ProjectID: project.ID, TaskID: missingClaim.ID, ClaimID: testutil.QueryID(902)},
		}
		for number := len(claims); number < 256; number++ {
			claims = append(claims, model.WorkerTaskReference{ProjectID: project.ID, TaskID: testutil.QueryID(2000 + number), ClaimID: testutil.QueryID(3000 + number)})
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
		if item.ProjectName != project.Name || item.Task.ID == valid.TaskID && (testutil.Worker(t, item.Task.Properties).ClaimID != valid.ClaimID || testutil.Worker(t, item.Task.Properties).UserID != userID || testutil.Worker(t, item.Task.Properties).WorkerID != workerID) {
			t.Fatalf("reported source lost its current claim or Project name: %#v", item)
		}
	}
	for _, ref := range []model.WorkerTaskReference{otherUser, valid, otherWorker, wrongClaim, completed, wrongProject} {
		if !seen[ref.TaskID] {
			t.Fatalf("accessible task missing from batch: %s", ref.TaskID)
		}
	}
	if !reflect.DeepEqual(testutil.CurrentTaskFacts(t, database.Pool), before) {
		t.Fatal("observation normalization changed execution or opaque PR bytes")
	}
	err = testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
		items, err = tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{}})
		return err
	})
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("empty complete inventory: %#v %v", items, err)
	}
}

func TestWorkerSnapshotReadsCurrentVisibilityWithoutReplacingSavedState(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	userID, workerID := testutil.QueryID(1), testutil.QueryID(2)
	project, revoked := testutil.QueryProject(t, database.Pool, database, 10), testutil.QueryProject(t, database.Pool, database, 11)
	for id, role := range map[string]string{project.ID: "admin", revoked.ID: "member"} {
		testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, id, userID, role)
	}
	active := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 20, userID, workerID)
	removed := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 21, userID, workerID)
	private := testutil.SetSnapshotTaskClaim(t, database.Pool, database, revoked.ID, 22, userID, workerID)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := testutil.WorkerSnapshotFixture(userID, workerID, stamp)
	worker.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &stamp, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{}}
	err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
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
	testutil.MustExec(t, database.Pool, `UPDATE tasks SET status='done',title='Current title' WHERE id=$1`, active.TaskID)
	testutil.MustExec(t, database.Pool, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, active.TaskID)
	testutil.PutTaskProperty(t, database.Pool, active.TaskID, "pullRequests", []byte(`[]`))
	testutil.MustExec(t, database.Pool, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, removed.TaskID)
	testutil.MustExec(t, database.Pool, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, revoked.ID, userID)
	read := testutil.ReadWorkerSnapshot(t, database, userID, workerID, stamp.Add(time.Hour))
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
	before := testutil.CurrentTaskFacts(t, database.Pool)
	err = testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
		items, err := tx.WorkerDAO().ReportTaskSnapshots(ctx, userID, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{private}})
		if err == nil && len(items) != 0 {
			t.Errorf("report retained a revoked project's task: %#v", items)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, revoked.ID, userID)
	restored := testutil.ReadWorkerSnapshot(t, database, userID, workerID, stamp.Add(time.Hour))
	if len(restored.TaskSnapshot.Items) != 2 || !reflect.DeepEqual(restored.TaskSnapshot.Items[1], worker.TaskSnapshot.Items[2]) {
		t.Fatalf("regrant did not restore the historical observation: %#v", restored.TaskSnapshot)
	}
	var saved model.WorkerSnapshot
	var savedErr error
	saved, savedErr = pg.ScanWorkerSnapshot(database.Pool.QueryRow(ctx, `SELECT `+pg.WorkerSnapshotProjection+` FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID))
	if savedErr != nil {
		t.Fatal(savedErr)
	}
	if !reflect.DeepEqual(saved, worker) || !reflect.DeepEqual(testutil.CurrentTaskFacts(t, database.Pool), before) {
		t.Fatal("visibility checks changed the saved snapshot or task facts")
	}
}

func TestWorkerSnapshotRecentWindowAccountIsolationAndStablePagination(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	userID := testutil.QueryID(1)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	for index := 2; index < 6; index++ {
		worker := testutil.WorkerSnapshotFixture(userID, testutil.QueryID(index), stamp.Add(time.Duration(index)*time.Second))
		worker.LastReportedAt = stamp
		if index == 4 {
			worker.LastReportedAt = stamp.Add(-72 * time.Hour)
		}
		if index == 5 {
			worker.LastReportedAt = stamp.Add(-72*time.Hour - time.Microsecond)
		}
		testutil.PutWorkerSnapshot(t, database, worker)
	}
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(testutil.QueryID(100), testutil.QueryID(2), stamp))
	var position *Position
	for index, expectedID := range []string{testutil.QueryID(2), testutil.QueryID(3), testutil.QueryID(4)} {
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
		testutil.PutWorkerSnapshot(t, database, last)
	}
	for _, test := range []struct{ user, worker string }{{userID, testutil.QueryID(5)}, {testutil.QueryID(101), testutil.QueryID(2)}, {userID, testutil.QueryID(900)}} {
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.WorkerDAO().Worker(ctx, test.user, test.worker, stamp)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unknown/inaccessible/expired worker exposed: %v", err)
		}
	}
	testutil.ReadWorkerSnapshot(t, database, userID, testutil.QueryID(4), stamp)
}

func TestWorkerSnapshotConcurrentAdmissionResamplesAfterLock(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	worker := testutil.WorkerSnapshotFixture(testutil.QueryID(1), testutil.QueryID(2), time.Now().UTC())
	ready, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	var firstTime time.Time
	go func() {
		first <- testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
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
		second <- testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
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
	testutil.WaitForQueryLock(t, database.Pool, "SELECT pg_advisory_xact_lock")
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

func TestWorkerSnapshotReadCancellationAndCorruptStorageStayVisible(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := testutil.WorkerSnapshotFixture(testutil.QueryID(1), testutil.QueryID(2), stamp)
	testutil.PutWorkerSnapshot(t, database, worker)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
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
	testutil.MustExec(t, database.Pool, `UPDATE workers SET telemetry='{"cpu":"invalid"}' WHERE user_id=$1 AND worker_id=$2`, worker.UserID, worker.WorkerID)
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.WorkerDAO().Workers(ctx, worker.UserID, stamp, Page{Limit: 10})
		return err
	})
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("corrupt worker metadata was hidden as an empty list: %v", err)
	}
}

func TestWorkerSnapshotEncodingFailureRetainsCause(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	worker := testutil.WorkerSnapshotFixture(testutil.QueryID(1), testutil.QueryID(2), time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC))
	worker.Telemetry.CPU.Value = &model.WorkerCPU{UsagePercent: math.NaN()}
	err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error { _, err := tx.WorkerDAO().UpsertWorker(ctx, worker); return err })
	if err == nil || !strings.Contains(err.Error(), "worker") || errors.Unwrap(err) == nil {
		t.Fatalf("invalid telemetry encoding was hidden: %v", err)
	}
}
