package store

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func workerSnapshotFixture(userID, workerID string, stamp time.Time) core.WorkerSnapshot {
	return core.WorkerSnapshot{
		UserID: userID, WorkerID: workerID, CreatedAt: stamp, LastReportedAt: stamp,
		Telemetry:    core.WorkerTelemetry{Machine: core.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: core.PlatformLinux, WorkingDirectory: "/workspace", SampledAt: stamp},
		TaskSnapshot: core.WorkerTaskObservation{State: core.WorkerTasksUnavailable, Items: []core.WorkerObservedTask{}},
	}
}

func putWorkerSnapshot(t *testing.T, database *Store, worker core.WorkerSnapshot) core.WorkerSnapshot {
	t.Helper()
	var result core.WorkerSnapshot
	err := database.WriteWorker(context.Background(), func(tx *WorkerTx) error {
		var err error
		result, err = tx.UpsertWorker(context.Background(), worker)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func readWorkerSnapshot(t *testing.T, database *Store, userID, workerID string, observedAt time.Time) core.WorkerSnapshot {
	t.Helper()
	var result core.WorkerSnapshot
	err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		var err error
		result, err = snapshot.Worker(context.Background(), userID, workerID, observedAt)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func setSnapshotTaskClaim(t *testing.T, database *Store, projectID string, taskNumber int, owner, workerID string) core.WorkerTaskReference {
	t.Helper()
	task := queryTask(t, database, projectID, taskNumber, core.TaskInProgress)
	claim := &core.WorkerClaim{ClaimID: queryID(taskNumber + 100), State: core.WorkerActive, UserID: owner, WorkerID: workerID,
		Machine: core.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: core.PlatformLinux, Agent: core.AgentClaude,
		AgentControlMode: core.AgentControlModeWeb, WorktreeID: queryID(taskNumber + 200), Phase: core.WorkerExecuting, ClaimedAt: task.CreatedAt}
	properties := fixtureTaskProperties(t, claim)
	putTaskPropertyFixture(t, database, task.ID, "worker", properties["worker"])
	putTaskPropertyFixture(t, database, task.ID, "pullRequests", []byte(`[{"url":"\u0000","title":"\ud800"}]`))
	return core.WorkerTaskReference{ProjectID: projectID, TaskID: task.ID, ClaimID: claim.ClaimID}
}

func TestWorkerSnapshotUpsertUnknownStaleAndOlderObservation(t *testing.T) {
	database := isolatedStore(t)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	first := putWorkerSnapshot(t, database, worker)
	if first.TaskSnapshot.State != core.WorkerTasksUnavailable || first.TaskSnapshot.ObservedAt != nil || first.TaskSnapshot.Items == nil {
		t.Fatalf("initial unknown inventory changed: %#v", first)
	}
	worker.CreatedAt = stamp.Add(time.Hour)
	worker.LastReportedAt = stamp.Add(time.Second)
	unknown := putWorkerSnapshot(t, database, worker)
	if unknown.TaskSnapshot.State != core.WorkerTasksUnavailable || !unknown.CreatedAt.Equal(stamp) {
		t.Fatalf("repeated unknown inventory or immutable creation changed: %#v", unknown)
	}
	worker.LastReportedAt = stamp.Add(2 * time.Second)
	worker.TaskSnapshot = core.WorkerTaskObservation{State: core.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp,
		Items: []core.WorkerObservedTask{{ProjectID: queryID(10), TaskID: queryID(11), ClaimID: queryID(12), Title: "Original task", ProjectName: "Project", Status: core.TaskInProgress, Phase: core.WorkerExecuting, Agent: core.AgentClaude}}}
	observed := putWorkerSnapshot(t, database, worker)
	worker.LastReportedAt = stamp.Add(3 * time.Second)
	worker.TaskSnapshot = core.WorkerTaskObservation{State: core.WorkerTasksUnavailable, Items: []core.WorkerObservedTask{}}
	stale := putWorkerSnapshot(t, database, worker)
	if stale.TaskSnapshot.State != core.WorkerTasksStale || !reflect.DeepEqual(stale.TaskSnapshot.Items, observed.TaskSnapshot.Items) || !stale.TaskSnapshot.ObservedAt.Equal(*observed.TaskSnapshot.ObservedAt) {
		t.Fatalf("null inventory did not retain the last real task observation: %#v", stale)
	}
	worker.LastReportedAt = stamp.Add(time.Second)
	worker.Telemetry.Machine.Name = "Older report"
	older := putWorkerSnapshot(t, database, worker)
	if !reflect.DeepEqual(older, stale) {
		t.Fatalf("older report overwrote the latest full snapshot: %#v", older)
	}
	worker.LastReportedAt = stamp.Add(4 * time.Second)
	worker.TaskSnapshot = core.WorkerTaskObservation{State: core.WorkerTasksObserved, ObservedAt: &worker.LastReportedAt, InventoryObservedAt: &stamp, Items: []core.WorkerObservedTask{}}
	empty := putWorkerSnapshot(t, database, worker)
	if empty.TaskSnapshot.State != core.WorkerTasksObserved || len(empty.TaskSnapshot.Items) != 0 || empty.TaskSnapshot.Items == nil {
		t.Fatalf("real empty inventory was not a complete observation: %#v", empty)
	}
}

func TestWorkerSnapshotNormalizesTaskReferencesWithoutChangingTasks(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	userID, workerID := queryID(1), queryID(2)
	project := queryProject(t, database, 10)
	otherProject := queryProject(t, database, 11)
	mustQueryExec(t, database, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, userID)
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
	missingClaim := queryTask(t, database, project.ID, 28, core.TaskInProgress)
	missing := core.WorkerTaskReference{ProjectID: project.ID, TaskID: queryID(900), ClaimID: queryID(901)}
	before := currentTaskFactsFixture(t, database)
	var items []core.WorkerObservedTask
	err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		clock, err := tx.ObservedAt(ctx)
		if err != nil || clock.IsZero() || clock.Location() != time.UTC {
			t.Errorf("invalid database observation: %v, %v", clock, err)
			return err
		}
		items, err = tx.ReportTaskSnapshots(ctx, userID, workerID, core.WorkerTaskInventory{ObservedAt: clock, Claims: []core.WorkerTaskReference{
			otherUser, valid, otherWorker, wrongClaim, completed, deleted, noMembership, wrongProject, missing,
			{ProjectID: project.ID, TaskID: missingClaim.ID, ClaimID: queryID(902)},
		}})
		return err
	})
	if err != nil || len(items) != 1 || items[0].TaskID != valid.TaskID || items[0].Phase != core.WorkerExecuting || items[0].Agent != core.AgentClaude || items[0].Status != core.TaskInProgress {
		t.Fatalf("task references were not authoritatively normalized: %#v, %v", items, err)
	}
	if !reflect.DeepEqual(currentTaskFactsFixture(t, database), before) {
		t.Fatal("observation normalization changed execution or opaque PR bytes")
	}
	err = database.WriteWorker(ctx, func(tx *WorkerTx) error {
		items, err = tx.ReportTaskSnapshots(ctx, userID, workerID, core.WorkerTaskInventory{Claims: []core.WorkerTaskReference{}})
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
	for _, id := range []string{project.ID, revoked.ID} {
		mustQueryExec(t, database, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')`, id, userID)
	}
	active := setSnapshotTaskClaim(t, database, project.ID, 20, userID, workerID)
	removed := setSnapshotTaskClaim(t, database, project.ID, 21, userID, workerID)
	private := setSnapshotTaskClaim(t, database, revoked.ID, 22, userID, workerID)
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(userID, workerID, stamp)
	worker.TaskSnapshot = core.WorkerTaskObservation{State: core.WorkerTasksObserved, ObservedAt: &stamp, InventoryObservedAt: &stamp, Items: []core.WorkerObservedTask{}}
	err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		var err error
		worker.TaskSnapshot.Items, err = tx.ReportTaskSnapshots(ctx, userID, workerID, core.WorkerTaskInventory{Claims: []core.WorkerTaskReference{active, removed, private}})
		if err != nil {
			return err
		}
		_, err = tx.UpsertWorker(ctx, worker)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE tasks SET status='done',title='Current title' WHERE id=$1`, active.TaskID)
	mustQueryExec(t, database, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, active.TaskID)
	putTaskPropertyFixture(t, database, active.TaskID, "pullRequests", []byte(`[]`))
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, removed.TaskID)
	mustQueryExec(t, database, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, revoked.ID, userID)
	read := readWorkerSnapshot(t, database, userID, workerID, stamp.Add(time.Hour))
	if len(read.TaskSnapshot.Items) != 1 || read.TaskSnapshot.Items[0].TaskID != active.TaskID || read.TaskSnapshot.Items[0].Status != core.TaskInProgress || read.TaskSnapshot.Items[0].Title != "Task" || read.TaskSnapshot.Items[0].Phase != core.WorkerExecuting {
		t.Fatalf("current permission filtering changed saved state or leaked rows: %#v", read.TaskSnapshot)
	}
	var page WorkerPage
	err = database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		var err error
		page, err = snapshot.Workers(ctx, userID, stamp.Add(time.Hour), Page{Limit: 50})
		return err
	})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], read) {
		t.Fatalf("list/detail visibility differs: %#v %v", page, err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT jsonb_array_length(task_snapshot->'items') FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("GET changed retained source snapshot: count %d, %v", count, err)
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
		err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			page, err = snapshot.Workers(ctx, userID, stamp, Page{Limit: 1, After: position})
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
		err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			_, err := snapshot.Worker(ctx, test.user, test.worker, stamp)
			return err
		})
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("unknown/inaccessible/expired worker exposed: %v", err)
		}
	}
	readWorkerSnapshot(t, database, userID, queryID(4), stamp)
}

func TestWorkerSnapshotConcurrentOlderObservationReadsCommittedWinner(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	older := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	newer := older
	newer.LastReportedAt = stamp.Add(time.Second)
	newer.Telemetry.Machine.Name = "Winning report"
	ready, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- database.WriteWorker(ctx, func(tx *WorkerTx) error {
			if _, err := tx.UpsertWorker(ctx, newer); err != nil {
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
	var result core.WorkerSnapshot
	go func() {
		second <- database.WriteWorker(ctx, func(tx *WorkerTx) error {
			var err error
			result, err = tx.UpsertWorker(ctx, older)
			return err
		})
	}()
	waitForQueryLock(t, database, "INSERT INTO workers")
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if !result.LastReportedAt.Equal(newer.LastReportedAt) || result.Telemetry.Machine.Name != newer.Telemetry.Machine.Name {
		t.Fatalf("ignored write could not observe the committed winner: %#v", result)
	}
}

func TestWorkerSnapshotErrorsRollbackAndPreserveCauses(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	want := errors.New("observation unavailable")
	err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		if _, err := tx.UpsertWorker(ctx, worker); err != nil {
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
	worker.Telemetry.CPU.Value = &core.WorkerCPU{UsagePercent: math.NaN()}
	err = database.WriteWorker(ctx, func(tx *WorkerTx) error { _, err := tx.UpsertWorker(ctx, worker); return err })
	if err == nil || !strings.Contains(err.Error(), "worker") || errors.Unwrap(err) == nil {
		t.Fatalf("invalid telemetry encoding was hidden: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := database.WriteWorker(canceled, func(*WorkerTx) error { t.Error("canceled transaction entered"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transaction: %v", err)
	}
	project := queryProject(t, database, 10)
	mustQueryExec(t, database, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, worker.UserID)
	reference := setSnapshotTaskClaim(t, database, project.ID, 20, worker.UserID, worker.WorkerID)
	putTaskPropertyFixture(t, database, reference.TaskID, "worker", []byte(`not JSON`))
	err = database.WriteWorker(ctx, func(tx *WorkerTx) error {
		_, err := tx.ReportTaskSnapshots(ctx, worker.UserID, worker.WorkerID, core.WorkerTaskInventory{Claims: []core.WorkerTaskReference{reference}})
		return err
	})
	if err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("invalid opaque task properties were hidden: %v", err)
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
	err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		_, err := tx.ObservedAt(canceled)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled database clock hid its cause: %v", err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.Workers(canceled, worker.UserID, stamp, Page{Limit: 10})
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled worker list hid its cause: %v", err)
	}
	mustQueryExec(t, database, `UPDATE workers SET telemetry='{"cpu":"invalid"}' WHERE user_id=$1 AND worker_id=$2`, worker.UserID, worker.WorkerID)
	err = database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.Workers(ctx, worker.UserID, stamp, Page{Limit: 10})
		return err
	})
	if err == nil || errors.Is(err, core.ErrNotFound) {
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
	claim := &core.WorkerClaim{ClaimID: queryID(120), State: core.WorkerActive, UserID: queryID(1), WorkerID: queryID(2),
		Machine: core.WorkerMachine{ID: queryID(999), Name: "Worker"}, Platform: core.PlatformLinux, Agent: core.AgentClaude,
		AgentControlMode: core.AgentControlModeWeb, WorktreeID: queryID(220), Phase: core.WorkerExecuting, ClaimedAt: time.Now().UTC()}
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
	if _, err := scanWorkerSnapshot(workerSnapshotRow(func(...any) error { return want })); !errors.Is(err, want) {
		t.Fatalf("scan failure lost cause: %v", err)
	}
	for _, values := range []struct{ telemetry, tasks string }{{`{"cpu":"invalid"}`, `{}`}, {`{}`, `{"items":"invalid"}`}} {
		_, err := scanWorkerSnapshot(workerSnapshotRow(func(destinations ...any) error {
			*destinations[4].(*[]byte) = []byte(values.telemetry)
			*destinations[5].(*[]byte) = []byte(values.tasks)
			return nil
		}))
		if err == nil {
			t.Fatal("stored invalid typed snapshot was silently accepted")
		}
	}
	if _, err := scanWorkerSnapshot(workerSnapshotRow(func(...any) error { return pgx.ErrNoRows })); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("not-found scan changed cause: %v", err)
	}
}
