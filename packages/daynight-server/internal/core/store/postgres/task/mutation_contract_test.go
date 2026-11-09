package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/jackc/pgx/v5/pgconn"
)

func cancelledMaterialWrite(t *testing.T, database *postgres.Store, current model.Task, change func(*store.TaskWrite)) model.Task {
	t.Helper()
	values := testutil.TaskWrite(current)
	change(&values)
	var result model.Task
	err := writerWrite(t, database, current.ProjectID, func(scope store.TaskWriteDAO) error {
		var err error
		result, err = scope.UpdateTask(t.Context(), current.ID, values)
		return err
	})
	if err != nil {
		t.Fatalf("material write did not commit: %v", err)
	}
	if actual := testutil.SnapshotTask(t, database, current.ProjectID, current.ID); !reflect.DeepEqual(actual, result) {
		t.Fatalf("material write result differs from persistence: %#v %#v", result, actual)
	}
	return result
}

func TestCancelledTaskStoragePreservesMaterialsAndTerminalProjections(t *testing.T) {
	database := writerStore(t)
	owner, _, project := testutil.ProjectMembershipFixture(t, database)
	ctx := t.Context()
	predecessor := writerTask(t, database, project.ID, 10, model.TaskTodo)
	target := writerTask(t, database, project.ID, 11, model.TaskTodo, predecessor.ID)
	other := writerTask(t, database, project.ID, 12, model.TaskTodo)
	external := writerTask(t, database, project.ID, 13, model.TaskCancelled)
	follower := writerTask(t, database, project.ID, 14, model.TaskTodo, target.ID, other.ID, external.ID)
	follower = cancelledMaterialWrite(t, database, follower, func(values *store.TaskWrite) {
		values.ExternalDependsOn = []string{external.ID}
	})
	platform := model.TaskPlatform(model.PlatformLinux)
	target = cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) {
		values.Title, values.Description = "Cancelled target", "Readable retained task material"
		values.AllowAgents, values.AssignedTo, values.RequiredPlatform = true, &owner.UserID, &platform
		values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"https://example.test/pr/1","title":"Retained result"}]`)}
	})
	testutil.SeedStep(t, database.Pool, target.ID, "abcdef01", 0)
	message := writerAppendThread(t, database, target.ID, owner.UserID, "Retained discussion")
	attachment, created, err := database.PutAttachment(ctx, model.Attachment{
		ProjectID: project.ID, TaskID: target.ID, Path: "retained.txt", ContentType: "text/plain", SizeBytes: 25,
	})
	if err != nil || !created {
		t.Fatalf("attachment material fixture: %#v created=%t %v", attachment, created, err)
	}
	var beforeSteps []model.TaskStep
	if err := writerRead(t, database, func(scope store.TaskReader) error {
		var err error
		beforeSteps, err = scope.TaskSteps(ctx, target.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var beforeEpoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&beforeEpoch); err != nil {
		t.Fatal(err)
	}
	if target.Ready || !slices.Equal(target.BlockedBy, []string{predecessor.ID}) {
		t.Fatalf("target must have an unfinished prerequisite: %#v", target)
	}
	cancelled := cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if cancelled.CancelledAt == nil || cancelled.CancelledAt.Location() != time.UTC || !cancelled.CancelledAt.Equal(cancelled.UpdatedAt) ||
		cancelled.Status != model.TaskCancelled || cancelled.Ready || cancelled.Version != target.Version+1 {
		t.Fatalf("cancellation did not retain a terminal database timestamp: %#v", cancelled)
	}
	comparable := cancelled
	comparable.Status, comparable.Version, comparable.UpdatedAt, comparable.CancelledAt = target.Status, target.Version, target.UpdatedAt, target.CancelledAt
	if !reflect.DeepEqual(comparable, target) {
		t.Fatalf("cancellation changed unrelated Task facts: before=%#v after=%#v", target, cancelled)
	}
	if err := writerRead(t, database, func(scope store.TaskReader) error {
		presence, err := scope.TaskPresence(ctx, project.ID, target.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("cancelled Task became absent or deleted: %#v %v", presence, err)
		}
		steps, err := scope.TaskSteps(ctx, target.ID)
		if err != nil || !reflect.DeepEqual(steps, beforeSteps) {
			t.Fatalf("cancellation changed or hid Steps: %#v %v", steps, err)
		}
		storedMessage, err := scope.ThreadMessage(ctx, target.ID, message.ID)
		if err != nil || !reflect.DeepEqual(storedMessage, message) {
			t.Fatalf("cancellation changed or hid discussion: %#v %v", storedMessage, err)
		}
		storedAttachment, err := writerAttachment(t, database, project.ID, target.ID, attachment.Path)
		if err != nil || !reflect.DeepEqual(storedAttachment, attachment) {
			t.Fatalf("cancellation changed or hid attachment metadata: %#v %v", storedAttachment, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	remaining := testutil.SnapshotTask(t, database, project.ID, follower.ID)
	if remaining.Ready || remaining.Version != follower.Version || !slices.Equal(remaining.BlockedBy, []string{other.ID}) ||
		!slices.Equal(remaining.DependsOn, follower.DependsOn) || !slices.Equal(remaining.ExternalDependsOn, []string{external.ID}) {
		t.Fatalf("cancelled ordinary/external prerequisites changed follower identity or remaining blockers: %#v", remaining)
	}
	cancelledMaterialWrite(t, database, other, func(values *store.TaskWrite) { values.Status = model.TaskDone })
	ready := testutil.SnapshotTask(t, database, project.ID, follower.ID)
	if !ready.Ready || len(ready.BlockedBy) != 0 || ready.Version != follower.Version {
		t.Fatalf("cancelled ordinary/external prerequisites did not satisfy the follower: %#v", ready)
	}
	if err := writerRead(t, database, func(scope store.TaskReader) error {
		graph, err := scope.TaskGraphTasks(ctx, project.ID, target.ID, store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}, 160)
		if err != nil {
			return err
		}
		found := false
		for _, node := range graph {
			if node.ID == target.ID {
				found = true
				if node.Status != model.TaskCancelled || !reflect.DeepEqual(node.CancelledAt, cancelled.CancelledAt) || !slices.Equal(node.DependsOn, target.DependsOn) {
					t.Fatalf("graph lost cancellation time or dependencies: %#v", node)
				}
			}
		}
		if !found {
			t.Fatal("graph omitted the live cancelled Task")
		}
		sync, err := scope.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		found = false
		for _, record := range sync {
			if record.ID == target.ID {
				found = true
				if record.Status != model.TaskCancelled || !reflect.DeepEqual(record.CancelledAt, cancelled.CancelledAt) {
					t.Fatalf("sync lost cancellation time: %#v", record)
				}
			}
		}
		if !found {
			t.Fatal("sync omitted the live cancelled Task")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	expression, err := query.Parse("Cancelled")
	if err != nil {
		t.Fatal(err)
	}
	status := model.TaskCancelled
	if err := writerSearch(t, database, func(scope store.TaskSearchSnapshot) error {
		page, err := scope.Matches(ctx, project.ID, store.TaskSearchQuery{Expression: expression, Status: &status, Limit: 10})
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != target.ID || !reflect.DeepEqual(page.Items[0].CancelledAt, cancelled.CancelledAt) {
			t.Fatalf("search lost cancelled status filtering or timestamp: %#v %v", page, err)
		}
		fence, err := scope.Fence(ctx, project.ID)
		if err != nil || fence.Epoch != beforeEpoch {
			t.Fatalf("cancellation rotated the deletion epoch: %#v %v", fence, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledTaskStoragePreservesCompletedIntervalAndReleasedWorker(t *testing.T) {
	database := writerStore(t)
	owner, _, project := testutil.ProjectMembershipFixture(t, database)
	target := writerTask(t, database, project.ID, 11, model.TaskTodo)
	started := cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) { values.Status = model.TaskInProgress })
	completed := cancelledMaterialWrite(t, database, started, func(values *store.TaskWrite) { values.Status = model.TaskDone })
	follower := writerTask(t, database, project.ID, 12, model.TaskInProgress, target.ID)
	cancelled := cancelledMaterialWrite(t, database, completed, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if cancelled.CancelledAt == nil || !reflect.DeepEqual(cancelled.StartedAt, completed.StartedAt) || !reflect.DeepEqual(cancelled.CompletedAt, completed.CompletedAt) {
		t.Fatalf("done cancellation replaced the execution interval: %#v %#v", completed, cancelled)
	}
	edited := cancelledMaterialWrite(t, database, cancelled, func(values *store.TaskWrite) { values.Description = "Readable edited cancellation" })
	if !reflect.DeepEqual(edited.CancelledAt, cancelled.CancelledAt) || !reflect.DeepEqual(edited.StartedAt, completed.StartedAt) || !reflect.DeepEqual(edited.CompletedAt, completed.CompletedAt) {
		t.Fatalf("cancelled metadata edit changed terminal timing: %#v", edited)
	}
	if got := testutil.SnapshotTask(t, database, project.ID, follower.ID); !reflect.DeepEqual(got, follower) {
		t.Fatalf("done cancellation changed an already-started follower: %#v %#v", follower, got)
	}
	released := writerTask(t, database, project.ID, 13, model.TaskTodo)
	history := testutil.WorkerClaim(13, owner.UserID, testutil.QueryID(50), model.WorkerReleased)
	released = cancelledMaterialWrite(t, database, released, func(values *store.TaskWrite) {
		values.AllowAgents = true
		values.Properties = testutil.TaskProperties(t, history)
	})
	beforeProperties := released.Properties
	retained := cancelledMaterialWrite(t, database, released, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if !reflect.DeepEqual(retained.Properties, beforeProperties) || !reflect.DeepEqual(testutil.Worker(t, retained.Properties), history) {
		t.Fatalf("cancellation rewrote released Worker history: %#v", retained)
	}
}

func TestTaskDescriptionUpdatesPersistRawMarkdownAndUnrelatedFacts(t *testing.T) {
	database := writerStore(t)
	ctx := t.Context()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 11, model.TaskTodo)
	text := "  # 原始 Markdown 😀\r\n\r\n[方案](plans/设计.md?raw=1#section)\r\n<script>window.example = '<&>'</script>\r\n`代码` \u2028\r\n"
	for _, description := range []string{text, strings.Replace(text, "原始", "完整", 1)} {
		before := task
		values := testutil.TaskWrite(before)
		values.Description = description
		err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
			var err error
			task, err = scope.UpdateTask(ctx, before.ID, values)
			return err
		})
		if err != nil || task.Description != description ||
			task.Version != before.Version+1 || !task.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("raw description write changed bytes or revision: %#v %v", task, err)
		}
		comparable := task
		comparable.Description, comparable.Version, comparable.UpdatedAt = before.Description, before.Version, before.UpdatedAt
		if !reflect.DeepEqual(comparable, before) {
			t.Fatalf("description update changed unrelated persisted facts: %#v %#v", before, task)
		}
		if stored := testutil.SnapshotTask(t, database, project.ID, task.ID); stored.Description != description || !reflect.DeepEqual(stored, task) {
			t.Fatalf("description readback changed raw Markdown or metadata: %#v %#v", task, stored)
		}
	}
}

func TestTaskCompletionCommitsAtMaximumRevision(t *testing.T) {
	database := writerStore(t)
	ctx := t.Context()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 11, model.TaskTodo)
	values := testutil.TaskWrite(task)
	values.Status = model.TaskInProgress
	if err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
		_, err := scope.UpdateTask(ctx, task.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, database.Pool, "UPDATE tasks SET version=$1 WHERE id=$2", int64(math.MaxInt64-1), task.ID)
	before := testutil.SnapshotTask(t, database, project.ID, task.ID)
	if before.StartedAt == nil || before.CompletedAt != nil || before.Version != math.MaxInt64-1 {
		t.Fatalf("maximum completion fixture lost its current interval: %#v", before)
	}
	values = testutil.TaskWrite(before)
	values.Status = model.TaskDone
	var completed model.Task
	err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
		var err error
		completed, err = scope.UpdateTask(ctx, task.ID, values)
		return err
	})
	if err != nil || completed.Version != math.MaxInt64 || completed.Status != model.TaskDone ||
		!reflect.DeepEqual(completed.StartedAt, before.StartedAt) || completed.CompletedAt == nil || !completed.CompletedAt.Equal(completed.UpdatedAt) {
		t.Fatalf("maximum revision completion did not commit its exact interval: %#v %v", completed, err)
	}
	for range 2 {
		if stored := testutil.SnapshotTask(t, database, project.ID, task.ID); !reflect.DeepEqual(stored, completed) {
			t.Fatalf("maximum revision persisted read changed facts: %#v %#v", completed, stored)
		}
	}
}

func TestTaskDeleteAndDependentLookupFailuresPreserveCauses(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	pre := writerTask(t, database, project.ID, 11, model.TaskDone)
	dependent := writerTask(t, database, project.ID, 12, model.TaskTodo, pre.ID)
	var expired store.TaskWriteDAO
	if err := writerWrite(t, database, project.ID, func(tx store.TaskWriteDAO) error {
		expired = tx
		ids, err := tx.DependentIDs(ctx, pre.ID)
		if err != nil || !reflect.DeepEqual(ids, []string{dependent.ID}) {
			t.Fatalf("direct dependent lookup: %v %v", ids, err)
		}
		if _, err := tx.DeleteTask(ctx, testutil.QueryID(99), false); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing delete swallowed: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := writerWrite(t, database, project.ID, func(tx store.TaskWriteDAO) error {
		if _, err := tx.DeleteTask(ctx, dependent.ID, false); err != nil {
			return err
		}
		ids, err := tx.DependentIDs(ctx, pre.ID)
		if err != nil || len(ids) != 0 {
			t.Fatalf("deleted sources retained as live dependents: %v %v", ids, err)
		}
		_, err = tx.DeleteTask(ctx, pre.ID, false)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := writerRead(t, database, func(snapshot store.TaskReader) error {
		_, err := snapshot.Task(ctx, project.ID, pre.ID)
		if !errors.Is(err, model.ErrTaskDeleted) {
			t.Fatalf("deleted marker was not observed: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := expired.DependentIDs(ctx, pre.ID); return err },
		func() error { _, err := expired.DeleteTask(ctx, pre.ID, false); return err },
		func() error { _, err := expired.DeleteTask(ctx, pre.ID, true); return err },
	} {
		err := operation()
		var failure *store.Error
		if !errors.As(err, &failure) || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("closed transaction lost database cause: %v", err)
		}
	}
}

func TestTaskDeleteRemoveDependsUpdatesOnlyIncomingSources(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project, other := writerProject(t, database, 1), writerProject(t, database, 2)
	root := writerTask(t, database, project.ID, 10, model.TaskDone)
	target := writerTask(t, database, project.ID, 11, model.TaskTodo, root.ID)
	source := writerTask(t, database, project.ID, 12, model.TaskTodo, target.ID, root.ID)
	foreign := writerTask(t, database, other.ID, 13, model.TaskTodo)
	if err := writerWrite(t, database, project.ID, func(tx store.TaskWriteDAO) error {
		_, err := tx.DeleteTask(ctx, target.ID, true)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	current := testutil.SnapshotTask(t, database, project.ID, source.ID)
	if current.Version != source.Version+1 || !reflect.DeepEqual(current.DependsOn, []string{root.ID}) || !current.Ready {
		t.Fatalf("source was not changed once: %#v", current)
	}
	if current := testutil.SnapshotTask(t, database, other.ID, foreign.ID); !reflect.DeepEqual(current, foreign) {
		t.Fatal("another project was modified")
	}
	var outgoing int
	if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND task_id=$2", project.ID, target.ID).Scan(&outgoing); err != nil || outgoing != 1 {
		t.Fatalf("target outgoing history removed: %d %v", outgoing, err)
	}
}

func TestTaskDeletionPreservesCompletedWorkerHistory(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	owner := testutil.QueryID(51)
	testutil.MustExec(t, database.Pool, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::uuid::text,now(),now())`, owner)
	testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, owner)
	claim := testutil.WorkerClaim(11, owner, testutil.QueryID(52), model.WorkerCompleted)
	target := writerWorkerTask(t, database, project.ID, 11, claim, true, nil)
	var before, after string
	readHistory := func() string {
		t.Helper()
		var history string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t)-ARRAY['updated_at','version','deleted_at'],
			'properties',(SELECT jsonb_object_agg(name,value) FROM task_properties WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, target.ID).Scan(&history); err != nil {
			t.Fatal(err)
		}
		return history
	}
	before = readHistory()
	var tombstone model.TaskTombstone
	if err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
		var err error
		tombstone, err = scope.DeleteTask(ctx, target.ID, false)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	after = readHistory()
	if before != after || tombstone.Version != target.Version+1 || tombstone.DeletedAt.Before(target.UpdatedAt) {
		t.Fatalf("soft deletion lost completed worker/material history: %s -> %s, %#v", before, after, tombstone)
	}
}

func TestTaskTodoGetPaginationAndReadiness(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	pending := writerTask(t, database, project.ID, 10, model.TaskTodo)
	done := writerTask(t, database, project.ID, 11, model.TaskDone)
	unblocked := writerTask(t, database, project.ID, 12, model.TaskTodo, done.ID)
	blocked := writerTask(t, database, project.ID, 13, model.TaskTodo, pending.ID)
	dependent := writerTask(t, database, project.ID, 14, model.TaskTodo, unblocked.ID)
	if err := writerRead(t, database, func(snapshot store.TaskReader) error {
		for _, task := range []model.Task{unblocked, blocked} {
			read, err := snapshot.Task(ctx, project.ID, task.ID)
			if err != nil || !reflect.DeepEqual(read, task) || read.Ready != (task.ID == unblocked.ID) {
				t.Fatalf("todo GET projection: %#v, %v", read, err)
			}
		}
		if len(unblocked.BlockedBy) != 0 || !slices.Equal(blocked.BlockedBy, []string{pending.ID}) || !slices.Equal(dependent.BlockedBy, []string{unblocked.ID}) || dependent.Ready {
			t.Fatalf("todo dependency projection: %#v, %#v, %#v", unblocked, blocked, dependent)
		}
		page := store.Page{Limit: 2}
		var listed []string
		for {
			result, err := snapshot.Tasks(ctx, project.ID, store.TaskQuery{Page: page})
			if err != nil {
				return err
			}
			for _, task := range result.Items {
				listed = append(listed, task.ID)
			}
			if !result.HasMore {
				break
			}
			last := result.Items[len(result.Items)-1]
			page.After = &store.Position{CreatedAt: last.CreatedAt, ID: last.ID}
		}
		if !slices.Equal(listed, []string{pending.ID, done.ID, unblocked.ID, blocked.ID, dependent.ID}) {
			t.Fatalf("paginated inventory omitted todo: %#v", listed)
		}
		ready := true
		result, err := snapshot.Tasks(ctx, project.ID, store.TaskQuery{Page: store.Page{Limit: 10}, Ready: &ready})
		if err != nil || len(result.Items) != 2 || result.Items[0].ID != pending.ID || result.Items[1].ID != unblocked.ID {
			t.Fatalf("todo readiness did not match prerequisites: %#v, %v", result, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func writerWorkerTask(t *testing.T, database *postgres.Store, projectID string, number int, claim *model.WorkerClaim, allow bool, platform *model.TaskPlatform) model.Task {
	t.Helper()
	status := model.TaskInProgress
	if claim != nil && claim.State == model.WorkerCompleted {
		status = model.TaskDone
	}
	task := writerTask(t, database, projectID, number, status)
	if claim != nil {
		properties := testutil.TaskProperties(t, claim)
		testutil.PutTaskProperty(t, database.Pool, task.ID, "worker", properties["worker"])
	}
	testutil.MustExec(t, database.Pool, `UPDATE tasks SET allow_agents=$2,required_platform=$3 WHERE id=$1`, task.ID, allow, platform)
	return testutil.SnapshotTask(t, database, projectID, task.ID)
}

func writerWorkerPage(t *testing.T, database *postgres.Store, projectID string, query store.TaskQuery) store.TaskPage {
	t.Helper()
	var page store.TaskPage
	if err := writerRead(t, database, func(scope store.TaskReader) error {
		var err error
		page, err = scope.Tasks(context.Background(), projectID, query)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestTaskWorkerInventoryFiltersBeforeLimitAndBindsWorkerAndUser(t *testing.T) {
	database := writerStore(t)
	project := writerProject(t, database, 1)
	owner, other, workerID := testutil.QueryID(2), testutil.QueryID(3), testutil.QueryID(5)
	writerTask(t, database, project.ID, 10, model.TaskTodo)
	writerWorkerTask(t, database, project.ID, 11, testutil.WorkerClaim(11, owner, testutil.QueryID(6), model.WorkerActive), true, nil)
	writerWorkerTask(t, database, project.ID, 12, testutil.WorkerClaim(12, other, workerID, model.WorkerActive), true, nil)
	writerWorkerTask(t, database, project.ID, 13, testutil.WorkerClaim(13, owner, workerID, model.WorkerReleased), true, nil)
	writerWorkerTask(t, database, project.ID, 14, testutil.WorkerClaim(14, owner, workerID, model.WorkerCompleted), true, nil)
	first := writerWorkerTask(t, database, project.ID, 15, testutil.WorkerClaim(15, owner, workerID, model.WorkerActive), true, nil)
	writerWorkerTask(t, database, project.ID, 16, testutil.WorkerClaim(16, other, workerID, model.WorkerActive), true, nil)
	second := writerWorkerTask(t, database, project.ID, 17, testutil.WorkerClaim(17, owner, workerID, model.WorkerActive), true, nil)
	manual := writerWorkerTask(t, database, project.ID, 18, testutil.WorkerClaim(18, owner, workerID, model.WorkerActive), false, testutil.Pointer(model.PlatformWindows))
	testutil.MustExec(t, database.Pool, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, first.ID, testutil.QueryID(14))
	want := []string{first.ID, second.ID, manual.ID}
	query := store.TaskQuery{Page: store.Page{Limit: 1}, Worker: &store.WorkerQuery{UserID: owner, WorkerID: workerID}}
	var ids []string
	for {
		page := writerWorkerPage(t, database, project.ID, query)
		if len(page.Items) != 1 {
			t.Fatalf("owned page lost a valid candidate: %+v", page)
		}
		ids = append(ids, page.Items[0].ID)
		if page.Items[0].ID == first.ID && (!slices.Equal(page.Items[0].DependsOn, []string{testutil.QueryID(14)}) || !slices.Equal(page.Items[0].ExternalDependsOn, []string{testutil.QueryID(14)}) || len(page.Items[0].BlockedBy) != 0 || !reflect.DeepEqual(testutil.Worker(t, page.Items[0].Properties), testutil.Worker(t, first.Properties))) {
			t.Fatalf("owned inventory lost the current claim or external dependency flags: %#v", page.Items[0])
		}
		if !page.HasMore {
			break
		}
		query.Page.After = &store.Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("ownership filter did not precede the page limit: %v want %v", ids, want)
	}
	for _, test := range []struct {
		query store.TaskQuery
		want  []string
	}{
		{store.TaskQuery{Ready: testutil.Pointer(false)}, want},
		{store.TaskQuery{Ready: testutil.Pointer(true)}, nil},
		{store.TaskQuery{AllowAgents: testutil.Pointer(true)}, want[:2]},
		{store.TaskQuery{AllowAgents: testutil.Pointer(false)}, want[2:]},
		{store.TaskQuery{CompatiblePlatform: testutil.Pointer(model.PlatformLinux)}, want[:2]},
		{store.TaskQuery{Status: testutil.Pointer(model.TaskInProgress)}, want},
		{store.TaskQuery{Status: testutil.Pointer(model.TaskTodo)}, nil},
	} {
		test.query.Page, test.query.Worker = store.Page{Limit: 100}, &store.WorkerQuery{UserID: owner, WorkerID: workerID}
		page := writerWorkerPage(t, database, project.ID, test.query)
		var actual []string
		for _, task := range page.Items {
			actual = append(actual, task.ID)
		}
		if !slices.Equal(actual, test.want) || page.HasMore {
			t.Fatalf("combined filter changed inventory: %v want %v", actual, test.want)
		}
	}
}

func TestTaskWorkerInventoryTracksCurrentClaimAcrossOwnershipChanges(t *testing.T) {
	database := writerStore(t)
	project := writerProject(t, database, 1)
	owner, workerID := testutil.QueryID(2), testutil.QueryID(3)
	claim := testutil.WorkerClaim(10, owner, workerID, model.WorkerActive)
	target := writerWorkerTask(t, database, project.ID, 10, claim, true, nil)
	query := store.TaskQuery{Page: store.Page{Limit: 1}, Worker: &store.WorkerQuery{UserID: owner, WorkerID: workerID}}
	check := func(expected *model.WorkerClaim) {
		t.Helper()
		page := writerWorkerPage(t, database, project.ID, query)
		if expected == nil {
			if len(page.Items) != 0 || page.HasMore {
				t.Fatalf("historical claim remained in inventory: %+v", page)
			}
			return
		}
		if len(page.Items) != 1 || page.Items[0].ID != target.ID || !reflect.DeepEqual(testutil.Worker(t, page.Items[0].Properties), expected) || page.HasMore {
			t.Fatalf("inventory selected a stale claim: %+v", page)
		}
	}
	check(claim)
	for _, state := range []model.WorkerState{model.WorkerReleased, model.WorkerActive, model.WorkerCompleted, model.WorkerActive} {
		claim = testutil.WorkerClaim(20+int(target.Version), owner, workerID, state)
		values := testutil.TaskWrite(target)
		values.Properties = testutil.TaskProperties(t, claim)
		if state == model.WorkerCompleted {
			values.Status = model.TaskDone
		} else {
			values.Status = model.TaskInProgress
		}
		if err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
			var err error
			target, err = scope.UpdateTask(context.Background(), target.ID, values)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if state == model.WorkerActive {
			check(claim)
		} else {
			check(nil)
		}
	}
	values := testutil.TaskWrite(target)
	values.Properties, values.AllowAgents = model.TaskProperties{}, false
	if err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
		_, err := scope.UpdateTask(context.Background(), target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	check(nil)
}

func TestTaskWorkerInventoryPreservesJSONDecodeFailure(t *testing.T) {
	database := writerStore(t)
	project := writerProject(t, database, 1)
	target := writerTask(t, database, project.ID, 2, model.TaskTodo)
	testutil.PutTaskProperty(t, database.Pool, target.ID, "worker", []byte(`{"workerId":123}`))
	var page store.TaskPage
	err := writerRead(t, database, func(scope store.TaskReader) error {
		var err error
		page, err = scope.Tasks(context.Background(), project.ID, store.TaskQuery{Page: store.Page{Limit: 1}, Worker: &store.WorkerQuery{UserID: testutil.QueryID(3), WorkerID: testutil.QueryID(4)}})
		return err
	})
	var failure *store.Error
	var invalid *json.UnmarshalTypeError
	if !errors.As(err, &failure) || !errors.As(err, &invalid) || errors.Unwrap(err) == nil || len(page.Items) != 0 {
		t.Fatalf("invalid persisted ownership became an empty success or lost its cause: %+v %v", page, err)
	}
}

func TestTaskTimingReplacesTheLatestIntervalAndPreservesEdits(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 11, model.TaskTodo)
	write := func(status model.TaskStatus, title string) model.Task {
		t.Helper()
		var updated model.Task
		if err := writerWrite(t, database, project.ID, func(tx store.TaskWriteDAO) error {
			var err error
			updated, err = tx.UpdateTask(ctx, task.ID, store.TaskWrite{Title: title, Status: status})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return updated
	}
	started := write(model.TaskInProgress, "Started")
	if started.StartedAt == nil || started.CompletedAt != nil || !started.StartedAt.Equal(started.UpdatedAt) || started.StartedAt.Location() != time.UTC {
		t.Fatalf("start was not generated by the status statement: %#v", started)
	}
	edited := write(model.TaskInProgress, "Edited while running")
	if !reflect.DeepEqual(edited.StartedAt, started.StartedAt) || edited.CompletedAt != nil {
		t.Fatalf("same-state metadata edit reset timing: %#v", edited)
	}
	completed := write(model.TaskDone, "Completed")
	if !reflect.DeepEqual(completed.StartedAt, started.StartedAt) || completed.CompletedAt == nil || !completed.CompletedAt.Equal(completed.UpdatedAt) || completed.CompletedAt.Before(*completed.StartedAt) {
		t.Fatalf("completion did not freeze the interval: %#v", completed)
	}
	finishedEdit := write(model.TaskDone, "Edited after completion")
	if !reflect.DeepEqual(finishedEdit.StartedAt, completed.StartedAt) || !reflect.DeepEqual(finishedEdit.CompletedAt, completed.CompletedAt) {
		t.Fatalf("completed metadata edit changed interval: %#v", finishedEdit)
	}
	reset := write(model.TaskTodo, "New attempt preparation")
	if reset.StartedAt != nil || reset.CompletedAt != nil {
		t.Fatalf("leaving a completed interval retained old timing: %#v", reset)
	}
	restarted := write(model.TaskInProgress, "New attempt")
	if restarted.StartedAt == nil || !restarted.StartedAt.After(*completed.CompletedAt) || restarted.CompletedAt != nil {
		t.Fatalf("new execution reused a previous attempt: %#v", restarted)
	}
	reentered := write(model.TaskTodo, "Paused attempt")
	if reentered.StartedAt != nil || reentered.CompletedAt != nil {
		t.Fatalf("returning to todo retained execution timing: %#v", reentered)
	}
	latest := write(model.TaskInProgress, "Latest attempt")
	if latest.StartedAt == nil || !latest.StartedAt.After(*restarted.StartedAt) || latest.CompletedAt != nil {
		t.Fatalf("actual reentry accumulated rather than replaced timing: %#v", latest)
	}
	legacy := writerTask(t, database, project.ID, 12, model.TaskInProgress)
	if err := writerWrite(t, database, project.ID, func(tx store.TaskWriteDAO) error {
		var err error
		legacy, err = tx.UpdateTask(ctx, legacy.ID, store.TaskWrite{Title: "Legacy completion", Status: model.TaskDone})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if legacy.StartedAt != nil || legacy.CompletedAt == nil || !legacy.CompletedAt.Equal(legacy.UpdatedAt) {
		t.Fatalf("legacy completion invented a start or lost a real end: %#v", legacy)
	}
}

func TestTaskDependencyWritesRetainExactCountsAndClassification(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	ids := make([]string, 16)
	for i := range ids {
		ids[i] = writerTask(t, database, project.ID, i+11, model.TaskTodo).ID
	}
	var target model.Task
	values := store.TaskWrite{Title: "Target", Status: model.TaskTodo, DependsOn: slices.Clone(ids[:15]), ExternalDependsOn: slices.Clone(ids[:2])}
	if err := writerWrite(t, database, project.ID, func(scope store.TaskWriteDAO) error {
		var err error
		target, err = scope.CreateTask(ctx, testutil.QueryID(30), values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var stored, external []string
	if err := database.Pool.QueryRow(ctx, `SELECT ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE task_id=$1 ORDER BY depends_on_task_id),ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE task_id=$1 AND external ORDER BY depends_on_task_id)`, target.ID).Scan(&stored, &external); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(stored, ids[:15]) || !slices.Equal(external, ids[:2]) || target.Ready {
		t.Fatalf("fifteen stored edges lost order/classification: %#v %#v %#v", stored, external, target)
	}
}

func TestTaskReadAndWriteDatabaseFailures(t *testing.T) {
	database := writerStore(t)
	ctx := t.Context()
	project := writerProject(t, database, 1)
	target := writerTask(t, database, project.ID, 11, model.TaskTodo)
	testutil.MustExec(t, database.Pool, "DROP TABLE tasks")
	operations := []func() error{
		func() error {
			return writerRead(t, database, func(dao store.TaskReader) error {
				_, err := dao.Task(ctx, project.ID, target.ID)
				return err
			})
		},
		func() error {
			return writerRead(t, database, func(dao store.TaskReader) error {
				_, err := dao.Tasks(ctx, project.ID, store.TaskQuery{Page: store.Page{Limit: 10}})
				return err
			})
		},
		func() error {
			return writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
				_, err := dao.CreateTask(ctx, testutil.QueryID(12), store.TaskWrite{Title: "New", Status: model.TaskTodo})
				return err
			})
		},
		func() error {
			return writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
				values := testutil.TaskWrite(target)
				values.Title = "Changed"
				_, err := dao.UpdateTask(ctx, target.ID, values)
				return err
			})
		},
	}
	for _, operation := range operations {
		err := operation()
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "42P01" {
			t.Fatalf("missing Task relation lost its driver cause: %v", err)
		}
	}
}
